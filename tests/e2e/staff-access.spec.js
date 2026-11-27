'use strict';
// Only the IT group may open the admin section of staff.html. The test signs in the way a person would:
// password first, then the one-time code from the (simulated) authenticator panel.
const { test, expect } = require('./fixtures');

const DENIED = 'Access denied: only the IT group may do this.';

// The demo accounts are listed on the page itself (they are fake), so the tests read them from there.
async function demoUsers(page) {
  await page.goto('staff.html');
  // The accounts are saved once the page has finished creating them, so wait for that before using the page.
  await page.waitForFunction(() => !!localStorage.getItem('northlight-staff-v1'));
  const rows = await page.$$eval('#demo-accounts tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  return rows.map(([name, group, role, username, password]) => ({ name, group, role, username, password }));
}

async function signIn(page, user) {
  await page.fill('#username', user.username);
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#code-form')).toBeVisible();
  await expect(page.locator('#auth-code')).toHaveText(/^\d{6}$/);
  await page.fill('#code', (await page.locator('#auth-code').textContent()).trim());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('#session')).toBeVisible();
  await expect(page.locator('#who')).toContainText(user.name);
}

const NON_IT = ['Design', 'Sales'];

for (const group of NON_IT) {
  for (const index of [0, 1]) {
    test(`a ${group} user (${index + 1} of 2) cannot see the admin section`, async ({ page }) => {
      const users = (await demoUsers(page)).filter((u) => u.group === group);
      expect(users.length).toBe(2);
      const user = users[index];
      await signIn(page, user);
      await expect(page.locator('#who')).toContainText(group);

      // Nothing about the admin section is visible after signing in.
      await expect(page.locator('#admin')).toBeHidden();

      // Asking for it is refused, and it stays hidden.
      await page.getByRole('button', { name: 'Open admin section' }).click();
      await expect(page.locator('#status')).toHaveText(DENIED);
      await expect(page.locator('#admin')).toBeHidden();

      // Even if someone un-hides it with the browser tools, there is nothing in it: no accounts, no Leaver
      // buttons, and the Joiner form is refused.
      await page.evaluate(() => { document.getElementById('admin').hidden = false; });
      await expect(page.locator('#admin')).toBeVisible();
      await expect(page.locator('#directory tr')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /as leaver/ })).toHaveCount(0);

      await page.fill('#j-name', 'Eve Fake');
      await page.locator('#joiner-form').getByRole('button', { name: 'Joiner' }).click();
      await expect(page.locator('#status')).toHaveText(DENIED);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('northlight-staff-v1')).users);
      expect(saved).toHaveLength(6);
      expect(saved.some((u) => u.name === 'Eve Fake')).toBe(false);
      expect(saved.every((u) => u.status === 'active')).toBe(true);
    });
  }
}

test('an IT user can open the admin section (so the tests above are not empty)', async ({ page }) => {
  const users = (await demoUsers(page)).filter((u) => u.group === 'IT');
  expect(users.length).toBe(2);
  await signIn(page, users[0]);
  await page.getByRole('button', { name: 'Open admin section' }).click();
  await expect(page.locator('#admin')).toBeVisible();
  await expect(page.locator('#directory tr')).toHaveCount(6);
  await expect(page.getByRole('button', { name: /as leaver/ })).toHaveCount(6);
});

test('the admin section is not shown before signing in, or after a password with no code', async ({ page }) => {
  const users = await demoUsers(page);
  await expect(page.locator('#admin')).toBeHidden();
  const it = users.find((u) => u.group === 'IT');
  await page.fill('#username', it.username);
  await page.fill('#password', it.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#code-form')).toBeVisible();
  // Password only is not enough, and neither is a wrong code.
  await page.fill('#code', '000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.locator('#status')).toContainText(/Wrong code|already used/);
  await expect(page.locator('#session')).toBeHidden();
  await expect(page.locator('#admin')).toBeHidden();
});
