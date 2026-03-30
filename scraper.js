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

    // --- Helper: go to Purchase page ---
    async function goToPurchasePage() {
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
    }

    // --- Helper: open filter sidebar (FIXED) ---
    async function openFiltersPanel() {
      // Close any open popover/menu first
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);

      const filterButtons = page.locator('div[class*="toolbarItem"] button:has(span.MuiBadge-root)');
      const count = await filterButtons.count();
      console.log(`🔍 Filter-like buttons found: ${count}`);

      if (count === 0) {
        throw new Error('❌ No filter button found');
      }

      const filterButton = filterButtons.first();
      await filterButton.waitFor({ state: 'visible', timeout: 20000 });
      await filterButton.click();
      await page.waitForTimeout(2000);

      console.log('✅ Filter sidebar opened');
    }

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

    // --- Helper: check checkbox option inside accordion ---
    async function checkOptionInAccordion(accordion, optionText) {
      if (!accordion) return false;

      const label = await accordion.$(`label:has-text("${optionText}")`);
      if (!label) return false;

      const input = await label.$('input[type="checkbox"]');
      if (input && !(await input.isChecked())) {
        await label.click();
        await page.waitForTimeout(500);
      }

      return true;
    }

    // --- Helper: uncheck checkbox by label text ---
    async function uncheckOptionByLabelText(optionText) {
      const label = await page.$(`label:has-text("${optionText}")`);
      if (!label) {
        console.warn(`⚠️ Could not find '${optionText}' label`);
        return false;
      }

      const input = await label.$('input[type="checkbox"]');
      if (!input) {
        console.warn(`⚠️ Could not find checkbox inside '${optionText}' label`);
        return false;
      }

      const isChecked = await input.isChecked();
      if (isChecked) {
        await label.click();
        await page.waitForTimeout(500);
        console.log(`✅ '${optionText}' checkbox was checked and is now unchecked`);
      } else {
        console.log(`✅ '${optionText}' checkbox is already unchecked`);
      }

      return true;
    }

  async function selectSavedFilterAndReturnToPurchase(filterName) {
  const savedAccordion = await openAccordion('Saved filters & selections');
  if (!savedAccordion) {
    console.warn("⚠️ 'Saved filters & selections' accordion not found");
    return false;
  }

  const input = page.locator('input[placeholder="Saved filters"]').first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click();
  await page.waitForTimeout(500);
  await input.fill(filterName);
  await page.waitForTimeout(1000);

  let option = page.locator('[role="option"]', { hasText: filterName }).first();

  if (!(await option.count())) {
    const openBtn = page.locator('button[aria-label="Open"][title="Open"]').last();
    if (await openBtn.count()) {
      await openBtn.click();
      await page.waitForTimeout(1000);
    }
    option = page.locator('[role="option"]', { hasText: filterName }).first();
  }

  if (!(await option.count())) {
    console.warn(`⚠️ Saved filter not found: ${filterName}`);
    return false;
  }

  // Click and wait for navigation to complete
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
    option.click(),
  ]);

  console.log(`✅ Saved filter clicked: ${filterName}`);
  await page.waitForTimeout(3000);

  // Navigate back to Purchase page
  await goToPurchasePage();

  return true;
}
    // --- Floriday login ---
    await page.goto('https://idm.floriday.io/', { waitUntil: 'load' });
    await page.locator('input#identifier').fill(EMAIL);
    await page.click('button:has-text("Next")');
    await page.locator('input[name="credentials.passcode"]').fill(PASSWORD);
    await page.click('button:has-text("Verify")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5000);

    // --- Go to Purchase page ---
    await goToPurchasePage();

    // --- Open filters first ---
    await openFiltersPanel();

    // --- Select saved filter Aalsmeer, then return to Purchase page ---
    const savedFilterApplied = await selectSavedFilterAndReturnToPurchase('Flowers Aalsmeer');
    if (!savedFilterApplied) {
      console.warn("⚠️ Proceeding without saved filter 'Aalsmeer'");
    }

    // --- Open filters again after returning ---
    await openFiltersPanel();

    // --- Apply Trade item filter ---
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

      console.log('✅ Trade item filter applied');
    } else {
      console.warn("⚠️ 'Trade item' accordion not found");
    }

    // --- All suppliers button ---
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

    // --- Uncheck Direct sales ---
    await uncheckOptionByLabelText('Direct sales');

    // --- Supply filter for Clock pre-sales only ---
    const supplyAccordion = await openAccordion('Supply');
    if (supplyAccordion) {
      const checked = await checkOptionInAccordion(supplyAccordion, 'Clock pre-sales');
      if (checked) {
        console.log("✅ 'Clock pre-sales' selected");
      } else {
        console.warn("⚠️ Could not find 'Clock pre-sales'");
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

    // --- Change items per page to 96 ---
    const pageSizeDropdown = await page.$('select.css-hh3ke9-pageSizeDropDownList');
    if (pageSizeDropdown) {
      await pageSizeDropdown.selectOption('96');
      await page.waitForTimeout(3000);
      console.log('✅ Items per page set to 96');
    } else {
      console.warn('⚠️ Page size dropdown not found');
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
        } catch (err) {
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

    // --- Final success status ---
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
