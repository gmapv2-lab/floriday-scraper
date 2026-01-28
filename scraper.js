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
  const startTime = Date.now(); // 👈 measure total runtime from here

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

  // This will help us close the browser even if something throws later
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
    const purchaseButton = page.locator('button.MuiTab-root:has-text("Purchase")');
    await purchaseButton.waitFor({ state: 'visible', timeout: 60000 });
    await purchaseButton.click();
    await page.waitForTimeout(3000);

    // --- Open filters ---
    await page.click('div.css-1qo59uw-toolbarItem > button.css-17mby96-button');
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
          const isCollapsed = await collapse.evaluate((el) =>
            el.classList.contains('MuiCollapse-hidden')
          );
          if (isCollapsed) {
            const button = await acc.$('button.MuiAccordionSummary-root');
            await button.click();
            await page.waitForTimeout(500);
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
          (el) => el.closest('label')?.innerText.trim()
        );
        if (labelText && labelText.includes('Cut flowers')) {
          if (!(await checkbox.isChecked())) await checkbox.check();
        } else {
          if (await checkbox.isChecked()) await checkbox.uncheck();
        }
      }
    }

    const allSuppliersBtn = await page.$(
      'div[data-test="supplier-filters-supplier-combo-box"] button:has-text("All")'
    );
    if (allSuppliersBtn) {
      const isSelected = await allSuppliersBtn.evaluate((el) =>
        el.classList.contains('css-mtautz-button-selected')
      );
      if (!isSelected) await allSuppliersBtn.click();
    }

    const supplyAccordion = await openAccordion('Supply');

    // Find the label for "Direct sales"
    const directSalesLabel = await page.$('label:has-text("Direct sales")');

    if (directSalesLabel) {
      const input = await directSalesLabel.$('input[type="checkbox"]');

      if (input) {
        const isChecked = await input.isChecked();
        if (isChecked) {
          await directSalesLabel.click(); // Click label to toggle off
          await page.waitForTimeout(500);
          console.log("✅ 'Direct sales' checkbox was checked and is now unchecked");
        } else {
          console.log("✅ 'Direct sales' checkbox is already unchecked");
        }
      } else {
        console.warn("⚠️ Could not find input inside 'Direct sales' label");
      }
    } else {
      console.warn("⚠️ Could not find 'Direct sales' label");
    }

    if (supplyAccordion) {
      async function checkSupplyOption(optionText) {
        const label = await supplyAccordion.$(`label:has-text("${optionText}")`);
        if (label) {
          const input = await label.$('input[type="checkbox"]');
          if (input && !(await input.isChecked())) {
            await label.click();
            await page.waitForTimeout(500);
          }
        }
      }
      await checkSupplyOption('Clock pre-sales');
      await checkSupplyOption('Aalsmeer');
    }

    // --- Click Search ---
    await page.click('button[data-test="explorer-filter-search-button"]');
    await page.waitForTimeout(5000);

    // --- Close filter sidebar ---
    const closeButton = page.locator(
      'button.MuiButtonBase-root.MuiIconButton-root.MuiIconButton-sizeMedium.css-dk99c2'
    );
    if (await closeButton.isVisible()) await closeButton.click();
    await page.waitForTimeout(1000);

    // --- Change items per page to 96 ---
    const pageSizeDropdown = await page.$('select.css-hh3ke9-pageSizeDropDownList');
    if (pageSizeDropdown) {
      await pageSizeDropdown.selectOption('96');
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

        // Packing code
        const packingCode = await product
          .$eval('div[style*="white-space: nowrap"] > div', (el) =>
            el.textContent.trim().split(' - ')[0]
          )
          .catch(() => '');

        // Quantity & Price combined (e.g., "80 * €0.37" or "60 * €0.37")
        let Quantity = '';

        try {
          // Get the text that may contain quantity
          const quantityText = await product.$eval('div.MuiBox-root.css-18biwo', (el) =>
            el.textContent.trim()
          );

          // 1️⃣ Try format like "×33×80"
          let qtyMatch = quantityText.match(/×(\d+)(?!.*×)/);
          let qty = qtyMatch ? qtyMatch[1] : '';

          // 2️⃣ If not found, try format like "60 pcs" or "60pcs"
          if (!qty) {
            const pcsMatch = quantityText.match(/(\d+)\s*pcs/i);
            qty = pcsMatch ? pcsMatch[1] : '';
          }

          // Get price text (e.g., "€0.37")
          const priceText = await product
            .$eval('div.MuiBox-root.css-nicbzb', (el) => el.textContent.trim())
            .catch(() => '');
          const priceOnly = priceText.replace('€', '').trim();

          // Combine intelligently
          if (priceOnly) {
            Quantity = qty ? `${qty} * €${priceOnly}` : `€${priceOnly}`;
          }
        } catch (err) {
          console.log('❌ Quantity or price not found for this product.');
        }

        // Farm name
        const farmName = await product
          .$eval('div.css-xfjc11-root', (el) => {
            const imgEl = el.querySelector('img');
            return imgEl?.alt?.trim() || el.textContent.trim();
          })
          .catch(() => '');

        // Characteristics
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

        // --- 🧩 Helper column (Q) ---
        let helperValue = '';
        try {
          // Simple case: Direct sales
          helperValue = await product.$eval(
            'div.MuiSelect-select.MuiSelect-standard.MuiInputBase-input.MuiInput-input',
            (el) => el.innerText.trim()
          );
        } catch {
          // ignore
        }
        if (!helperValue) {
          try {
            // Complex stacked case: Clock pre-sales + Daytrade
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

        // Time
        const timeValue = getUaeTimeFormatted();

        // --- Push row (Helper before Time) ---
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

      // Pagination
      const nextBtn = await page.$('button[aria-label="Go to next page"]');
      if (!nextBtn) break;
      const disabled = await nextBtn.getAttribute('disabled');
      if (disabled !== null) break;
      await nextBtn.click();
      await page.waitForTimeout(4000);
      pageNum++;
    }

    console.log(`🎉 Total collected: ${allProducts.length} products`);

    // --- Clear the entire target sheet before writing new data ---
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

    // --- Calculate runtime and update F13 with timestamp + runtime ---
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

    // Calculate runtime even on failure
    const endTime = Date.now();
    const runtimeMs = endTime - startTime;
    const runtimeText = formatRuntime(runtimeMs);

    // Mark failure in sheet
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
