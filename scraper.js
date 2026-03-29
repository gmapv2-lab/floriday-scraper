import { google } from 'googleapis';
import dotenv from 'dotenv';
import { firefox } from 'playwright';

dotenv.config();

// --- Get current UAE time ---
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

// --- Format runtime (ms) as "42s" or "2m 13s" ---
function formatRuntime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${remainingSeconds}s`;
}

(async () => {
  const startTime = Date.now();

  const EMAIL = process.env.FLORIDAY_EMAIL;
  const PASSWORD = process.env.FLORIDAY_PASSWORD;

  if (!EMAIL || !PASSWORD) {
    console.error('❌ FLORIDAY_EMAIL or FLORIDAY_PASSWORD is missing in .env');
    process.exit(1);
  }

  // --- Setup Google Sheets client early ---
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

  let browser = null;

  try {
    // --- Status: Scraping in progress ---
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `_config!F13`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['🟡 Scraping in progress...']] },
    });
    console.log('✅ Updated Status in Sheets to Scraping in Progress');

    // --- Launch browser ---
    browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    // --- Floriday login ---
    await page.goto('https://idm.floriday.io/', { waitUntil: 'load' });
    await page.locator('input#identifier').fill(EMAIL);
    await page.click('button:has-text("Next")');
    await page.locator('input[name="credentials.passcode"]').fill(PASSWORD);
    await page.click('button:has-text("Verify")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // --- Go to Explorer overview ---
    await page.goto('https://customers.floriday.io/explorer/overview', {
      waitUntil: 'networkidle',
    });

    // --- Click Purchase tab ---
    const purchaseButton = page.getByRole('tab', { name: /Purchase/i });
    await purchaseButton.waitFor({ state: 'visible', timeout: 60000 });
    await purchaseButton.click();
    await page.waitForTimeout(3000);

    // --- Open filters ---
    const filterButton = page.getByRole('button', { name: /Deliver/i }).first();
    await filterButton.waitFor({ state: 'visible', timeout: 60000 });
    await filterButton.click();
    await page.waitForTimeout(2000);

    // --- Accordion helper ---
    async function openAccordion(spanTextToFind) {
      const accordions = await page.$$('div.MuiAccordion-root');

      for (const acc of accordions) {
        const span = await acc.$('span');
        if (!span) continue;

        const spanText = await span.evaluate((el) => el.innerText.trim());

        if (spanText === spanTextToFind) {
          const collapse = await acc.$('div.MuiCollapse-root');

          if (collapse) {
            const isCollapsed = await collapse.evaluate((el) =>
              el.classList.contains('MuiCollapse-hidden')
            );

            if (isCollapsed) {
              const button = await acc.$('button.MuiAccordionSummary-root');
              if (button) {
                await button.click();
                await page.waitForTimeout(700);
              }
            }
          }

          return acc;
        }
      }

      return null;
    }

    // --- Apply filters ---
    const tradeAccordion = await openAccordion('Trade item');

    if (tradeAccordion) {
      const checkboxes = await tradeAccordion.$$('input[type="checkbox"]');

      for (const checkbox of checkboxes) {
        const labelText = await checkbox.evaluate(
          (el) => el.closest('label')?.innerText.trim() || ''
        );

        if (labelText && labelText.includes('Cut flowers')) {
          if (!(await checkbox.isChecked())) {
            await checkbox.check();
          }
        } else {
          if (await checkbox.isChecked()) {
            await checkbox.uncheck();
          }
        }
      }
    }

    const allSuppliersBtn = await page.$(
      'div[data-test="supplier-filters-supplier-combo-box"] button:has-text("All")'
    );

    if (allSuppliersBtn) {
      const btnText = await allSuppliersBtn.evaluate((el) => el.textContent.trim());
      if (btnText === 'All') {
        await allSuppliersBtn.click().catch(() => {});
      }
    }

    const supplyAccordion = await openAccordion('Supply');

    if (supplyAccordion) {
      // --- Direct sales ---
      const directSalesLabel = await supplyAccordion.$('label:has-text("Direct sales")');

      if (directSalesLabel) {
        const input = await directSalesLabel.$('input[type="checkbox"]');

        if (input) {
          const isChecked = await input.isChecked();

          if (isChecked) {
            await directSalesLabel.click();
            await page.waitForTimeout(500);
            console.log("✅ 'Direct sales' unchecked");
          } else {
            console.log("✅ 'Direct sales' already unchecked");
          }
        } else {
          console.warn("⚠️ No checkbox inside 'Direct sales'");
        }
      } else {
        console.warn("⚠️ 'Direct sales' not found inside Supply");
      }

      // --- Supply options ---
      async function checkSupplyOption(optionText) {
        const label = await supplyAccordion.$(`label:has-text("${optionText}")`);

        if (label) {
          const input = await label.$('input[type="checkbox"]');

          if (input) {
            const isChecked = await input.isChecked();

            if (!isChecked) {
              await label.click();
              await page.waitForTimeout(500);
              console.log(`✅ '${optionText}' checked`);
            } else {
              console.log(`✅ '${optionText}' already checked`);
            }
          } else {
            console.warn(`⚠️ No checkbox inside '${optionText}'`);
          }
        } else {
          console.warn(`⚠️ '${optionText}' not found inside Supply`);
        }
      }

      await checkSupplyOption('Clock pre-sales');
      await checkSupplyOption('Aalsmeer');
    } else {
      console.warn("⚠️ 'Supply' accordion not found");
    }

    // --- Click Search ---
    await page.click('button[data-test="explorer-filter-search-button"]');
    await page.waitForTimeout(5000);

    // --- Close filter sidebar ---
    try {
      const closeButton = page.locator('button[aria-label="Close"]').first();
      if (await closeButton.isVisible({ timeout: 3000 })) {
        await closeButton.click();
      }
    } catch {
      console.warn('⚠️ Close button not found');
    }

    await page.waitForTimeout(1000);

    // --- Change items per page to 96 ---
    let pageSizeChanged = false;

    try {
      const selects = page.locator('select');
      const count = await selects.count();

      for (let i = 0; i < count; i++) {
        const select = selects.nth(i);
        const options = await select.locator('option').allTextContents();

        if (options.some((t) => t.trim() === '96')) {
          await select.selectOption('96');
          pageSizeChanged = true;
          console.log('✅ Changed items per page to 96');
          break;
        }
      }
    } catch {
      console.warn('⚠️ Could not find page size dropdown');
    }

    if (pageSizeChanged) {
      await page.waitForTimeout(3000);
    }

    // --- Pagination loop ---
    const allProducts = [];
    let pageNum = 1;

    while (true) {
      console.log(`⏳ Scraping page ${pageNum}...`);

      await page.waitForSelector('div.css-2qghvq-gridContainer', { timeout: 60000 });

      const productHandles = await page.$$('div.css-2qghvq-gridContainer > div:not([data-test])');

      for (const product of productHandles) {
        const img = await product
          .$eval('.css-16275sc-imageContainer img', (el) => el.src)
          .catch(() => '');

        const detailsText = await product
          .$eval('.css-dcgd6i-itemDetails', (el) => el.innerText.trim())
          .catch(() => '');

        const lines = detailsText
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);

        const name = lines[0] || '';
        const variety = lines[1] || '';
        const code = lines[2] || '';

        const price = await product
          .$eval('div.MuiBox-root.css-nicbzb', (el) => el.textContent.trim())
          .catch(() => '');

        const packingCode = await product
          .$eval('div[style*="white-space: nowrap"] > div', (el) =>
            el.textContent.trim().split(' - ')[0]
          )
          .catch(() => '');

        let Quantity = '';

        try {
          const quantityText = await product.$eval('div.MuiBox-root.css-18biwo', (el) =>
            el.textContent.trim()
          );

          let qtyMatch = quantityText.match(/×(\d+)(?!.*×)/);
          let qty = qtyMatch ? qtyMatch[1] : '';

          if (!qty) {
            const pcsMatch = quantityText.match(/(\d+)\s*pcs/i);
            qty = pcsMatch ? pcsMatch[1] : '';
          }

          const priceText = await product
            .$eval('div.MuiBox-root.css-nicbzb', (el) => el.textContent.trim())
            .catch(() => '');

          const priceOnly = priceText.replace('€', '').trim();

          if (priceOnly) {
            Quantity = qty ? `${qty} * €${priceOnly}` : `€${priceOnly}`;
          }
        } catch {
          console.log('❌ Quantity or price not found for this product.');
        }

        const farmName = await product
          .$eval('div.css-xfjc11-root', (el) => {
            const imgEl = el.querySelector('img');
            return imgEl?.alt?.trim() || el.textContent.trim();
          })
          .catch(() => '');

        const characteristics = [];
        try {
          const charSpans = await product.$$(
            'div.css-1cvv3s4-characteristics div.css-1kukt2z-value span'
          );

          for (const span of charSpans) {
            const text = await span.evaluate((el) => el.textContent.trim());
            characteristics.push(text);
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
              const chip = el.querySelector('span.MuiChip-label')?.innerText;
              return chip ? `${main} (${chip})` : main;
            });
          } catch {
            // ignore
          }
        }

        if (!helperValue) helperValue = 'N/A';

        const timeValue = getUaeTimeFormatted();

        const row = [
          name,
          variety,
          code,
          packingCode,
          price,
          img,
          Quantity,
          farmName,
          characteristics.join(' | '),
          helperValue,
          timeValue,
        ];

        allProducts.push(row);
      }

      console.log(`✅ Page ${pageNum} scraped (${productHandles.length} products)`);

      const nextBtn = await page.$('button[aria-label="Go to next page"]');
      if (!nextBtn) break;

      const disabled = await nextBtn.getAttribute('disabled');
      if (disabled !== null) break;

      await nextBtn.click();
      await page.waitForTimeout(4000);
      pageNum++;
    }

    console.log(`🎉 Total collected: ${allProducts.length} products`);

    // --- Clear target sheet ---
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: process.env.TARGET_SHEET_NAME,
    });
    console.log('🧹 Cleared old data from sheet before appending new rows');

    // --- Write product data ---
    const values = [
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
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${process.env.TARGET_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });

    console.log('✅ Data saved to Google Sheet!');

    // --- Success status ---
    const endTime = Date.now();
    const runtimeMs = endTime - startTime;
    const runtimeText = formatRuntime(runtimeMs);
    const lastRunTime = getUaeTimeFormatted();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `_config!F13`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[`✅ ${lastRunTime} — ${runtimeText}`]],
      },
    });

    console.log(`🏁 Scraping completed! Runtime: ${runtimeText}`);
  } catch (err) {
    console.error('❌ Scraping failed:', err);

    const endTime = Date.now();
    const runtimeMs = endTime - startTime;
    const runtimeText = formatRuntime(runtimeMs);

    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `_config!F13`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[`❌ Failed at ${getUaeTimeFormatted()} — runtime ( ${runtimeText} )`]],
        },
      });
    } catch (updateErr) {
      console.error('❌ Failed to update failure status in sheet:', updateErr);
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
