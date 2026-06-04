import { google } from 'googleapis';
import dotenv from 'dotenv';
import { firefox } from 'playwright';

dotenv.config();

function getUaeTimeFormatted() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '');
}

function formatRuntime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let lastHeight = 0;
      let sameCount = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, 700);

        const currentHeight = document.body.scrollHeight;

        if (currentHeight === lastHeight) {
          sameCount++;
        } else {
          sameCount = 0;
          lastHeight = currentHeight;
        }

        if (sameCount >= 5) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  });

  await page.waitForTimeout(2000);
}

(async () => {
  const startTime = Date.now();

  const EMAIL = process.env.FLORIDAY_EMAIL;
  const PASSWORD = process.env.FLORIDAY_PASSWORD;

  if (!EMAIL || !PASSWORD) {
    console.error('❌ FLORIDAY_EMAIL or FLORIDAY_PASSWORD is missing in .env');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
  const TARGET_SHEET_NAME = process.env.TARGET_SHEET_NAME;

  if (!SPREADSHEET_ID || !TARGET_SHEET_NAME) {
    console.error('❌ GOOGLE_SHEET_ID or TARGET_SHEET_NAME is missing in .env');
    process.exit(1);
  }

  const FILTERED_URL =
    'https://customers.floriday.io/explorer/overview?a=CutProducts&rv=supply&rl=grid&wf=1&wt=53&rg=0&nwk=0&ti=ClockPresales&cwid=97f7c6e6-265a-45aa-be5d-c55a6236ff45&ip=partial&sb=SupplyLinePrice&plm=0&cur=EUR&fsi=0';

  let browser = null;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `_config!F13`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['🟡 Scraping in progress...']] },
    });

    console.log('✅ Updated Status in Sheets to Scraping in Progress');

    browser = await firefox.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    console.log('🔐 Opening login page...');
    await page.goto('https://idm.floriday.io/', { waitUntil: 'load' });

    await page.locator('input#identifier').fill(EMAIL);
    await page.click('button:has-text("Next")');

    await page.locator('input[name="credentials.passcode"]').fill(PASSWORD);
    await page.click('button:has-text("Verify")');

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);

    console.log('✅ Logged in successfully');

    console.log('🌐 Opening filtered Floriday URL directly...');
    await page.goto(FILTERED_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(5000);

    console.log('Current scraping URL:', page.url());

    const pageText = await page.locator('body').innerText().catch(() => '');

    if (
      pageText.includes('Something went wrong') ||
      pageText.includes('No results') ||
      pageText.trim().length < 50
    ) {
      console.log('🔄 Initial page looked incomplete, reloading once...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(5000);
    }

    console.log('✅ Filtered page loaded');

    try {
      const pageSizeSelect = await page.$('select[class*="pageSizeDropDown"]');

      if (pageSizeSelect) {
        await pageSizeSelect.selectOption('96');
        await page.waitForTimeout(4000);
        console.log('✅ Items per page set to 96');
      } else {
        console.warn('⚠️ Page size control not found, continuing with default');
      }
    } catch (err) {
      console.warn('⚠️ Could not set page size:', err.message);
    }

    const allProducts = [];
    const seenProducts = new Set();
    let pageNum = 1;

    while (true) {
      console.log(`⏳ Scraping page ${pageNum}...`);
      console.log('Scraping URL:', page.url());

      let gridContainer = null;

      for (const sel of [
        'div.css-2qghvq-gridContainer',
        'div[class*="gridContainer"]',
        'div[data-test="explorer-grid"]',
        'div[class*="explorerGrid"]',
      ]) {
        try {
          await page.waitForSelector(sel, { timeout: 15000 });
          gridContainer = sel;
          console.log(`✅ Grid found using: ${sel}`);
          break;
        } catch {
          // try next selector
        }
      }

      if (!gridContainer) {
        throw new Error('❌ Could not find product grid container');
      }

      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return el && el.children.length > 0;
        },
        gridContainer,
        { timeout: 30000 }
      ).catch(() => console.warn('⚠️ Timed out waiting for products'));

      await autoScroll(page);

      let productHandles = await page.$$(`${gridContainer} > div:not([data-test])`);

      if (!productHandles.length) {
        productHandles = await page.$$(`${gridContainer} > div`);
      }

      console.log(`📦 Products visible on this page: ${productHandles.length}`);

      for (const product of productHandles) {
        const img = await product
          .$eval('img', (el) => el.src)
          .catch(() => '');

        const detailsText = await product
          .$eval('[class*="itemDetails"]', (el) => el.innerText.trim())
          .catch(() => '');

        const lines = detailsText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        const name = lines[0] || '';
        const variety = lines[1] || '';
        const code = lines[2] || '';

        const price = await product
          .$eval('p.css-u8hob4', (el) => el.textContent.trim())
          .catch(() => '');

        const packingFullText = await product
          .$eval('div[style*="white-space: nowrap"] > div', (el) =>
            el.textContent.trim()
          )
          .catch(() => '');

        const packingCode = packingFullText
          ? packingFullText.split(' - ')[0].trim()
          : '';

        let quantity = '';

        try {
          const quantityText = await product
            .$eval('div.MuiBox-root.css-18biwo', (el) => el.textContent.trim())
            .catch(() => packingFullText);

          let qtyMatch = quantityText.match(/×\s*(\d+)(?!.*×)/);
          let qty = qtyMatch ? qtyMatch[1] : '';

          if (!qty) {
            const pcsMatch = quantityText.match(/(\d+)\s*pcs/i);
            qty = pcsMatch ? pcsMatch[1] : '';
          }

          const priceOnly = price.replace('€', '').trim();

          if (priceOnly) {
            quantity = qty ? `${qty} * €${priceOnly}` : `€${priceOnly}`;
          } else {
            quantity = qty || '';
          }
        } catch {
          // ignore quantity error
        }

        const farmName = await product
          .$eval('div.MuiStack-root.css-uq0cf4', (el) => {
            const textDiv = el.querySelector('div:last-child');
            return textDiv ? textDiv.textContent.trim() : '';
          })
          .catch(() => '');

        const characteristics = [];

        try {
          const charSpans = await product.$$(
            'div[class*="characteristics"] div[class*="value"] span'
          );

          for (const span of charSpans) {
            const text = await span.evaluate((el) => el.textContent.trim());
            if (text) characteristics.push(text);
          }
        } catch {
          // ignore
        }

        let helperValue = '';

        try {
          helperValue = await product.$eval(
            'div.MuiSelect-select.MuiSelect-standard.MuiInputBase-input.MuiInput-input',
            (el) => el.innerText.trim()
          );
        } catch {
          // ignore
        }

        if (!helperValue) {
          try {
            helperValue = await product.$eval('div.MuiStack-root.css-1v3wv53', (el) => {
              const main = el.querySelector('div')?.innerText || '';
              const chip = el.querySelector('span.MuiChip-label')?.innerText || '';
              return chip ? `${main} (${chip})` : main;
            });
          } catch {
            // ignore
          }
        }

        if (!helperValue) helperValue = 'N/A';

        const uniqueKey = `${name}|${variety}|${code}|${packingCode}|${price}|${farmName}`;

        if (seenProducts.has(uniqueKey)) {
          continue;
        }

        seenProducts.add(uniqueKey);

        allProducts.push([
          name,
          variety,
          code,
          packingCode,
          price,
          img,
          quantity,
          farmName,
          characteristics.join(' | '),
          helperValue,
          getUaeTimeFormatted(),
        ]);
      }

      console.log(`✅ Page ${pageNum} scraped`);
      console.log(`📊 Total collected so far: ${allProducts.length}`);

      const nextBtn = await page.$('button[aria-label="Go to next page"]');

      if (!nextBtn) {
        console.log('⏹ No next button — last page reached');
        break;
      }

      const disabled = await nextBtn.getAttribute('disabled');
      const ariaDisabled = await nextBtn.getAttribute('aria-disabled');

      console.log('Next button disabled:', disabled);
      console.log('Next button aria-disabled:', ariaDisabled);

      if (disabled !== null || ariaDisabled === 'true') {
        console.log('⏹ Next button disabled — last page reached');
        break;
      }

      console.log(`➡️ Going to page ${pageNum + 1}...`);

      await nextBtn.click();
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(3000);

      pageNum++;
    }

    console.log(`🎉 Total collected: ${allProducts.length} products`);

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: TARGET_SHEET_NAME,
    });

    console.log('🧹 Cleared old data from sheet');

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TARGET_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          [
            'Name',
            'Variety',
            'Code',
            'Packing Code',
            'Price',
            'Image',
            'Quantity',
            'Farm Name',
            'Characteristics',
            'Helper',
            'Time',
          ],
          ...allProducts,
        ],
      },
    });

    console.log('✅ Data saved to Google Sheet!');

    const endTime = Date.now();
    const runtimeText = formatRuntime(endTime - startTime);
    const lastRunTime = getUaeTimeFormatted();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `_config!F13`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[`✅ ${lastRunTime} — ${runtimeText}`]] },
    });

    console.log(`🏁 Scraping completed! Runtime: ${runtimeText}`);
  } catch (err) {
    console.error('❌ Scraping failed:', err);

    const runtimeText = formatRuntime(Date.now() - startTime);

    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `_config!F13`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[`❌ Failed at ${getUaeTimeFormatted()} — runtime (${runtimeText})`]],
        },
      });
    } catch (updateErr) {
      console.error('❌ Failed to update failure status:', updateErr);
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
