'use strict';
// Markup typed into a form must be shown as plain text, never turned into real elements or script.
// The shared page fixture (fixtures.js) also fails a test if an alert dialog opens, an error is thrown or the
// content security policy is broken, which is what a successful injection would look like.
const { test, expect } = require('./fixtures');

const NAME = '<b>Eve</b> Bold';
const MESSAGE = '<img src=x onerror="alert(1)"> <script>window.__pwned = 1</script> urgent help';

// Elements that only exist if typed markup was interpreted. The site's own pages use strong, not b or u.
const INJECTED = 'b, u, i, img[src="x"], script:not([src])';

async function nothingInjected(page) {
  expect(await page.evaluate(() => window.__pwned), 'typed script must not run').toBeUndefined();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
}

test('markup typed into the website form is shown as plain text on every page that shows it', async ({ page }) => {
  await page.goto('index.html');
  await page.fill('#c-name', NAME);
  await page.fill('#c-email', 'eve@example.com');
  await page.fill('#c-message', MESSAGE);
  await page.getByRole('button', { name: 'Send message' }).click();

  // The thank-you message repeats the name and lists what the rules did.
  const success = page.locator('#form-success');
  await expect(success).toBeVisible();
  await expect(success).toContainText('Thank you, ' + NAME + '.');
  await expect(success.locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);

  // The help desk ticket (the message is in the issue, the name is the requester).
  await page.goto('helpdesk.html');
  const ticket = page.locator('#list li', { hasText: 'Website enquiry' });
  await expect(ticket).toHaveCount(1);
  await expect(ticket).toContainText(NAME);
  await expect(ticket).toContainText(MESSAGE);
  await expect(page.locator('#list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);

  // The CRM lead.
  await page.goto('crm.html');
  const lead = page.locator('#lead-list li', { hasText: 'Eve' });
  await expect(lead).toHaveCount(1);
  await expect(lead).toContainText(NAME);
  await expect(page.locator('#lead-list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);

  // The outbox alert and the log (the message contains the word urgent, so there is an alert).
  await page.goto('automation.html');
  await expect(page.locator('#outbox-list li')).toHaveCount(1);
  await expect(page.locator('#outbox-list')).toContainText(MESSAGE);
  await expect(page.locator('#outbox-list')).toContainText(NAME);
  await expect(page.locator('#log-list')).toContainText('Event form.sent from ' + NAME);
  await expect(page.locator('#outbox-list, #log-list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);

  // And it is still plain text when everything is read back from storage after a reload.
  await page.reload();
  await expect(page.locator('#outbox-list')).toContainText(MESSAGE);
  await expect(page.locator('#outbox-list, #log-list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);
});

test('markup typed into the help desk form is shown as plain text', async ({ page }) => {
  await page.goto('helpdesk.html');
  await page.fill('#requester', '<u>Mallory</u>');
  await page.fill('#issue', '<img src=x onerror="alert(3)"> <script>window.__pwned = 3</script>');
  await page.getByRole('button', { name: 'Create ticket' }).click();

  const ticket = page.locator('#list li', { hasText: 'Mallory' });
  await expect(ticket).toHaveCount(1);
  await expect(ticket).toContainText('<u>Mallory</u>');
  await expect(ticket).toContainText('<img src=x onerror="alert(3)">');
  await expect(ticket).toContainText('<script>window.__pwned = 3</script>');
  await expect(page.locator('#list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);

  await page.reload();
  await expect(page.locator('#list li', { hasText: 'Mallory' })).toContainText('<u>Mallory</u>');
  await expect(page.locator('#list').locator(INJECTED)).toHaveCount(0);
  await nothingInjected(page);
});
