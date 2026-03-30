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
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    // --- Helper: open accordion by title ---
    async function openAccordion(titleText) {
      const accordions = await page.$$('div.MuiAccordion-root');
      for (const acc of accordions) {
        const titleNode = await acc.$('button.MuiAccordionSummary-root');
        if (!titleNode) continue;
        const titleTextFound = await titleNode.evaluate((el) =>
          el.innerText.replace(/\s+/g, ' ').trim()
        );
        if (titleTextFound.includes(titleText)) {
          const expanded = await titleNode.getAttribute('aria-expanded');
          if (expanded !== 'true') {
            await titleNode.click();
            await page.waitForTimeout(800);
          }
          return acc;
        }
      }
      return null;
    }

    // --- Login ---
    await page.goto('https://idm.floriday.io/', { waitUntil: 'load' });
    await page.locator('input#identifier').fill(EMAIL);
    await page.click('button:has-text("Next")');
    await page.locator('input[name="credentials.passcode"]').fill(PASSWORD);
    await page.click('button:has-text("Verify")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // --- Go to Purchase page ---
    await page.goto('https://customers.floriday.io/explorer/overview', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(3000);

    const purchaseButton = page.locator('button.MuiTab-root:has-text("Purchase")').first();
    await purchaseButton.waitFor({ state: 'visible', timeout: 60000 });
    await purchaseButton.click();
    await page.waitForTimeout(4000);
    console.log('✅ Purchase page opened');

    // --- Open filter sidebar ---
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);

    const filterButtons = page.locator('div[class*="toolbarItem"] button:has(span.MuiBadge-root)');
    const filterCount = await filterButtons.count();
    console.log(`🔍 Filter-like buttons found: ${filterCount}`);
    if (filterCount === 0) throw new Error('❌ No filter button found');

    await filterButtons.first().waitFor({ state: 'visible', timeout: 20000 });
    await filterButtons.first().click();
    await page.waitForTimeout(2000);
    console.log('✅ Filter sidebar opened');

    // --- Trade item: only Cut flowers ---
    const tradeAccordion = await openAccordion('Trade item');
    if (tradeAccordion) {
      const checkboxes = await tradeAccordion.$$('input[type="checkbox"]');
      for (const checkbox of checkboxes) {
        const labelText = await checkbox.evaluate(
          (el) => el.closest('label')?.innerText.trim() || ''
        );
        if (labelText.includes('Cut flowers')) {
          if (!(await checkbox.isChecked())) await checkbox.check();
        } else {
          if (await checkbox.isChecked()) await checkbox.uncheck();
        }
      }
      console.log('✅ Trade item filter applied');
    } else {
      console.warn("⚠️ 'Trade item' accordion not found");
    }

    // --- All suppliers ---
    const allSuppliersBtn = await page.$(
      'div[data-test="supplier-filters-supplier-combo-box"] button:has-text("All")'
    );
    if (allSuppliersBtn) {
      const isSelected = await allSuppliersBtn.evaluate((el) =>
        el.classList.contains('css-mtautz-button-selected')
      );
      if (!isSelected) {
        await allSuppliersBtn.click();
        await page.waitForTimeout(500);
      }
      console.log('✅ All suppliers selected');
    } else {
      console.warn("⚠️ 'All suppliers' button not found");
    }

    // --- Supply: uncheck Direct sales, check Clock pre-sales ---
    const supplyAccordion = await openAccordion('Supply');
    if (supplyAccordion) {
      const collapseArea = await supplyAccordion.$('div.MuiCollapse-root');
      if (collapseArea) {
        const checkboxRows = await collapseArea.$$('span.MuiCheckbox-root');
        for (const row of checkboxRows) {
          const text = await row.evaluate((el) => el.parentElement?.innerText.trim() || '');
          const input = await row.$('input[type="checkbox"]');
          if (!input) continue;
          const isChecked = await input.isChecked();

          if (text.includes('Direct sales')) {
            if (isChecked) {
              await row.evaluate((el) => el.querySelector('input').click());
              await page.waitForTimeout(500);
              console.log("✅ 'Direct sales' unchecked");
            } else {
              console.log("✅ 'Direct sales' already unchecked");
            }
          }

          if (text.includes('Clock pre-sales')) {
            if (!isChecked) {
              await row.evaluate((el) => el.querySelector('input').click());
              await page.waitForTimeout(500);
              console.log("✅ 'Clock pre-sales' checked");
            } else {
              console.log("✅ 'Clock pre-sales' already checked");
            }
          }
        }
      }
    } else {
      console.warn("⚠️ 'Supply' accordion not found");
    }

    // --- Click Search ---
    await page.click('button[data-test="explorer-filter-search-button"]');
    await page.waitForTimeout(5000);
    console.log('✅ Search clicked');

    // --- Close filter sidebar ---
    const closeButton = page.locator(
      'button.MuiButtonBase-root.MuiIconButton-root.MuiIconButton-sizeMedium.css-dk99c2'
    );
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await page.waitForTimeout(1000);
      console.log('✅ Filter sidebar closed');
    }

    // --- Page size: set to 96 ---
    try {
      const pageSizeSelect = await page.$('select[class*="pageSizeDropDown"]');
      if (pageSizeSelect) {
        await pageSizeSelect.selectOption('96');
        await page.waitForTimeout(3000);
        console.log('✅ Items per page set to 96');
      } else {
        console.warn('⚠️ Page size control not found, continuing with default');
      }
    } catch (err) {
      console.warn('⚠️ Could not set page size:', err.message);
    }

    // --- Pagination loop ---
    const allProducts = [];
    let pageNum = 1;

    while (true) {
      console.log(`⏳ Scraping page ${pageNum}...`);

      // Find grid container
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
          // try next
        }
      }

      if (!gridContainer) throw new Error('❌ Could not find product grid container');

      // Wait for products to actually load inside grid
      await page.waitForFunction(
        (sel) => (document.querySelector(sel)?.children.length ?? 0) > 0,
        gridContainer,
        { timeout: 30000 }
      ).catch(() => console.warn('⚠️ Timed out waiting for products'));

      let productHandles = await page.$$(`${gridContainer} > div:not([data-test])`);
      if (!productHandles.length) {
        productHandles = await page.$$(`${gridContainer} > div`);
      }

      console.log(`📦 Products on this page: ${productHandles.length}`);

      for (const product of productHandles) {
        const img = await product
          .$eval('img', (el) => el.src)
          .catch(() => '');

        const detailsText = await product
          .$eval('[class*="itemDetails"]', (el) => el.innerText.trim())
          .catch(() => '');

        const lines = detailsText.split('\n').map((l) => l.trim()).filter(Boolean);
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
          // ignore
        }

        const farmName = await product
          .$eval('div[class*="root"] img', (el) => el.alt?.trim() || '')
          .catch(() => '');

        const characteristics = [];
        try {
          const charSpans = await product.$$('div[class*="characteristics"] div[class*="value"] span');
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

        allProducts.push([
          name, variety, code, packingCode, price, img,
          Quantity, farmName, characteristics.join(' | '),
          helperValue, getUaeTimeFormatted(),
        ]);
      }

      console.log(`✅ Page ${pageNum} scraped (${productHandles.length} products)`);

      // --- Next page ---
      const nextBtn = await page.$('button[aria-label="Go to next page"]');
      if (!nextBtn) {
        console.log('⏹ No next button — last page reached');
        break;
      }
      const disabled = await nextBtn.getAttribute('disabled');
      if (disabled !== null) {
        console.log('⏹ Next button disabled — last page reached');
        break;
      }

      console.log(`➡️ Going to page ${pageNum + 1}...`);
      await nextBtn.click();
      await page.waitForTimeout(1000);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(2000);
      pageNum++;
    }

    console.log(`⏹ Pagination complete. Total pages: ${pageNum}`);
    console.log(`🎉 Total collected: ${allProducts.length} products`);

    // --- Write to sheet ---
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: process.env.TARGET_SHEET_NAME,
    });
    console.log('🧹 Cleared old data from sheet');

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${process.env.TARGET_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          ['Name', 'Variety', 'Code', 'Packing Code', 'Price', 'Image', 'Quantity', 'Farm Name', 'Characteristics', 'Helper', 'Time'],
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
          values: [[`❌ Failed at ${getUaeTimeFormatted()} — runtime ( ${runtimeText} )`]],
        },
      });
    } catch (updateErr) {
      console.error('❌ Failed to update failure status:', updateErr);
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
