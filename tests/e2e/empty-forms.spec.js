'use strict';
// Sending an empty form must say clearly what is wrong, and must not save anything.
// The website form and the CRM forms show their own messages next to each field. The help desk and sign-in
// forms use the browser's built-in "required" message, so those tests check that the browser blocks the send
// and names the problem (the wording of that message belongs to the browser and its language).
const { test, expect } = require('./fixtures');

const saved = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

test('the website form: an empty form shows a clear message for every field and creates nothing', async ({ page }) => {
  await page.goto('index.html');
  await page.getByRole('button', { name: 'Send message' }).click();

  // A summary at the top, which takes focus so it is read out, and a message under each field.
  const summary = page.locator('#form-errors');
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute('role', 'alert');
  await expect(summary).toContainText('Please fix 3 problems before sending:');
  const messages = {
    name: 'Enter your name.',
    email: 'Enter your email address so we can reply.',
    message: 'Write a short message about what you need.'
  };
  for (const [field, text] of Object.entries(messages)) {
    await expect(page.locator('#' + field + '-error')).toBeVisible();
    await expect(page.locator('#' + field + '-error')).toHaveText(text);
    await expect(summary).toContainText(text);
    await expect(page.locator('#c-' + field)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#c-' + field)).toHaveAttribute('aria-describedby', field + '-error');
  }
  await expect(page.locator('#form-success')).toBeHidden();

  // Nothing was created anywhere.
  for (const key of ['northlight-helpdesk-tickets', 'northlight-crm-v1', 'northlight-outbox', 'northlight-automation-log']) {
    expect(await saved(page, key), key).toBeNull();
  }
});

test('the website form: a message appears for a value that is there but wrong, and goes when it is fixed', async ({ page }) => {
  await page.goto('index.html');
  await page.fill('#c-name', 'A');
  await page.fill('#c-email', 'not-an-email');
  await page.fill('#c-message', 'Too short');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#name-error')).toContainText('must be 2 to 60 characters (you entered 1)');
  await expect(page.locator('#email-error')).toContainText('name@example.com');
  await expect(page.locator('#message-error')).toContainText('9 of at least 10 characters');
  expect(await saved(page, 'northlight-helpdesk-tickets')).toBeNull();

  await page.fill('#c-name', 'Sam Sample');
  await expect(page.locator('#name-error')).toBeHidden();
  await expect(page.locator('#c-name')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#email-error')).toBeVisible();
});

test('the CRM lead form: an empty form names every missing field and adds no lead', async ({ page }) => {
  await page.goto('crm.html');
  await expect(page.locator('#lead-list > li')).toHaveCount(3);
  await page.getByText('Add a lead', { exact: true }).click();
  await page.getByRole('button', { name: 'Add lead' }).click();

  await expect(page.locator('#status')).toHaveText('Please fix the highlighted fields.');
  const messages = {
    name: 'Enter the contact name.',
    company: 'Enter the company name.',
    email: 'Enter an email address.',
    value: 'Enter the estimated value in euros.'
  };
  for (const [field, text] of Object.entries(messages)) {
    await expect(page.locator('#l-' + field + '-error')).toHaveText(text);
    await expect(page.locator('#l-' + field)).toHaveAttribute('aria-invalid', 'true');
  }
  await expect(page.locator('#l-name')).toBeFocused();
  await expect(page.locator('#lead-list > li')).toHaveCount(3);
});

test('the CRM case form: missing subject and due time are named, and no case is added', async ({ page }) => {
  await page.goto('crm.html');
  await expect(page.locator('#case-list > li')).toHaveCount(1);
  await page.locator('#k-due').evaluate((el) => { el.value = ''; }); // the form suggests a due time: clear it
  await page.getByRole('button', { name: 'Create case' }).click();

  await expect(page.locator('#status')).toHaveText('Please fix the highlighted fields.');
  await expect(page.locator('#k-subject-error')).toHaveText('Describe the problem in a few words.');
  await expect(page.locator('#k-due-error')).toHaveText('Enter a due date and time.');
  await expect(page.locator('#k-subject')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#case-list > li')).toHaveCount(1);
});

test('the help desk form: the browser stops an empty form and names the field', async ({ page }) => {
  await page.goto('helpdesk.html');
  const before = await page.locator('#list > li').count();
  await page.getByRole('button', { name: 'Create ticket' }).click();

  for (const id of ['requester', 'issue']) {
    const state = await page.locator('#' + id).evaluate((el) => ({ missing: el.validity.valueMissing, message: el.validationMessage }));
    expect(state.missing, id + ' is required').toBe(true);
    expect(state.message.length, id + ' has a message').toBeGreaterThan(0);
  }
  await expect(page.locator('#requester')).toBeFocused(); // the browser points at the first empty field
  await expect(page.locator('#list > li')).toHaveCount(before);

  // Only spaces counts as empty too.
  await page.fill('#requester', '   ');
  await page.fill('#issue', '   ');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page.locator('#list > li')).toHaveCount(before);
});

test('the sign-in form: the browser stops an empty form and no code step opens', async ({ page }) => {
  await page.goto('staff.html');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const state = await page.locator('#username').evaluate((el) => ({ missing: el.validity.valueMissing, message: el.validationMessage }));
  expect(state.missing).toBe(true);
  expect(state.message.length).toBeGreaterThan(0);
  await expect(page.locator('#username')).toBeFocused();
  await expect(page.locator('#code-form')).toBeHidden();
  await expect(page.locator('#session')).toBeHidden();
});
