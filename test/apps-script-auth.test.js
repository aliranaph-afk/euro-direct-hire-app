const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

function createSheet(rows) {
  return {
    rows,
    getDataRange() {
      return { getValues: () => this.rows.map(row => [...row]) };
    },
    getLastRow() {
      return this.rows.length;
    },
    appendRow(row) {
      this.rows.push([...row]);
    },
    deleteRow(row) {
      this.rows.splice(row - 1, 1);
    },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValue: () => this.rows[row - 1]?.[column - 1] || "",
        getValues: () => {
          const height = rowCount || 1;
          const width = columnCount || 1;
          return Array.from({ length: height }, (_, rowOffset) =>
            Array.from({ length: width }, (_, columnOffset) =>
              this.rows[row + rowOffset - 1]?.[column + columnOffset - 1] || ""
            )
          );
        },
        setValue: value => {
          while (this.rows.length < row) this.rows.push([]);
          while (this.rows[row - 1].length < column) this.rows[row - 1].push("");
          this.rows[row - 1][column - 1] = value;
        },
        setValues: values => {
          values.forEach((valuesRow, rowOffset) => {
            const targetRow = row + rowOffset - 1;
            while (this.rows.length <= targetRow) this.rows.push([]);
            valuesRow.forEach((value, columnOffset) => {
              this.rows[targetRow][column + columnOffset - 1] = value;
            });
          });
        }
      };
    }
  };
}

function loadBackend(options = {}) {
  const cache = new Map([["OTP_test@example.com", "123456"]]);
  const sheets = {
    Users: createSheet([["User ID", "Email", "First Seen", "Tier", "Expiration", "Searches", "Last Search"]]),
    GCash_Payments: createSheet([
      ["Submitted", "Email", "Tier", "Reference", "Status", "Verified", "Payer"]
    ]),
    Payment_Audit: createSheet([
      ["Timestamp", "Event", "Email", "Tier", "Reference", "Payer Name", "Status", "Notes", "Actor"]
    ]),
    Job_Listings: createSheet([
      ["Title", "Country"],
      ["Welder", "France"],
      ["Senior Welder", "France"],
      ["welder", "Sweden"],
      ["CNC Operator", "Finland"]
    ])
  };
  const scriptProperties = new Map();
  if (options.admins) scriptProperties.set("ADMIN_EMAILS", options.admins);
  let uuid = 0;
  const scriptLock = {
    waitLock() {},
    releaseLock() {}
  };
  const context = {
    console,
    Date,
    Math,
    Object,
    String,
    Number,
    isNaN,
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(key) || null,
      put: (key, value) => cache.set(key, value),
      remove: key => cache.delete(key)
    }) },
    LockService: { getScriptLock: () => scriptLock },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => scriptProperties.get(key) || null,
      setProperty: (key, value) => scriptProperties.set(key, value)
    }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: name => sheets[name] || null,
      insertSheet: name => {
        sheets[name] = createSheet([]);
        return sheets[name];
      }
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (algorithm, value) => [...crypto.createHash(algorithm).update(value).digest()],
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString("base64url"),
      getUuid: () => `uuid-${++uuid}`,
      formatDate: date => new Date(date).toISOString().slice(0, 10)
    },
    Session: { getScriptTimeZone: () => "UTC" },
    console,
    GmailApp: { sendEmail: () => {} },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: text => ({
        text,
        setMimeType() { return this; }
      })
    }
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(require.resolve('../apps-script-backend.gs'), 'utf8'),
    context
  );
  return { context, sheets, cache, scriptProperties };
}

test('OTP verification creates a persisted hashed session accepted by validation', () => {
  const { context, sheets } = loadBackend();
  const response = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);

  assert.equal(response.success, true);
  assert.ok(response.sessionToken);
  assert.equal(sheets.Users.rows[0][7], 'Session Token Hashes');
  assert.notEqual(sheets.Users.rows[1][7], response.sessionToken);
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', response.sessionToken).text).success,
    true
  );
  assert.equal(
    JSON.parse(context.doPost({
      postData: {
        contents: JSON.stringify({
          action: 'validateSession',
          email: 'test@example.com',
          token: response.sessionToken
        })
      }
    }).text).success,
    true
  );
  assert.throws(
    () => context.handleValidateSession('test@example.com', 'invalid-token'),
    /saved session is no longer valid/
  );
  const unauthenticatedSearch = JSON.parse(context.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'search',
        email: 'test@example.com',
        token: 'invalid-token',
        position: '',
        country: ''
      })
    }
  }).text);
  assert.equal(unauthenticatedSearch.success, false);
  assert.match(unauthenticatedSearch.message, /saved session is no longer valid/);
});

test('verifying on another device preserves previously verified sessions', () => {
  const { context, sheets, cache } = loadBackend();
  const firstLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  cache.set('OTP_test@example.com', '654321');

  const secondLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '654321').text);

  assert.notEqual(firstLogin.sessionToken, secondLogin.sessionToken);
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', firstLogin.sessionToken).text).success,
    true
  );
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', secondLogin.sessionToken).text).success,
    true
  );
  assert.equal(String(sheets.Users.rows[1][7]).split(',').length, 2);
});

test('legacy sessions without expiry are invalidated when a new session is created', () => {
  const { context, sheets, cache } = loadBackend();
  context.handleVerifyOtp('test@example.com', '123456');
  const existingToken = 'legacy-session-token';
  sheets.Users.rows[1][7] = context.hashSessionToken_(existingToken);
  cache.set('OTP_test@example.com', '654321');

  const newLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '654321').text);

  assert.throws(
    () => context.handleValidateSession('test@example.com', existingToken),
    /saved session is no longer valid/
  );
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', newLogin.sessionToken).text).success,
    true
  );
});

test('expired session tokens are rejected and pruned from storage', () => {
  const { context, sheets } = loadBackend();
  const firstLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  const storedValue = sheets.Users.rows[1][7];
  const expiredEntry = storedValue.replace(/v2:/, 'v2:' + String(Date.now() - 86400000) + ':');
  sheets.Users.rows[1][7] = expiredEntry;

  assert.throws(
    () => context.handleValidateSession('test@example.com', firstLogin.sessionToken),
    /saved session is no longer valid/
  );
  assert.equal(String(sheets.Users.rows[1][7]).includes(firstLogin.sessionToken), false);
  assert.equal(String(sheets.Users.rows[1][7]).startsWith('v2:'), true);
});

test('job title suggestions require a valid session and return deduplicated titles', () => {
  const { context } = loadBackend();
  const verification = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  const response = JSON.parse(
    context.handleSuggestJobTitles('test@example.com', verification.sessionToken, 'wel').text
  );

  assert.deepEqual(Array.from(response.suggestions), ['Welder', 'Senior Welder']);
  assert.throws(
    () => context.handleSuggestJobTitles('test@example.com', 'bad-token', 'wel'),
    /saved session is no longer valid/
  );
});

test('invalid OTP requests are rejected and repeated sends are throttled', () => {
  const { context } = loadBackend();

  const invalidEmail = JSON.parse(context.handleSendOtp('not-an-email').text);
  assert.equal(invalidEmail.success, false);
  assert.match(invalidEmail.message, /valid email/i);

  const first = JSON.parse(context.handleSendOtp('secure@example.com').text);
  const second = JSON.parse(context.handleSendOtp('secure@example.com').text);
  const third = JSON.parse(context.handleSendOtp('secure@example.com').text);
  const fourth = JSON.parse(context.handleSendOtp('secure@example.com').text);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(third.success, true);
  assert.equal(fourth.success, false);
  assert.match(fourth.message, /Too many verification requests/i);
});

test('five failed OTP attempts lock out verification until the lock expires', () => {
  const { context } = loadBackend();
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = JSON.parse(context.handleVerifyOtp('test@example.com', '000000').text);
    assert.equal(result.success, false);
  }
  const locked = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  assert.equal(locked.success, false);
  assert.match(locked.message, /temporarily locked/i);
});

test('OTP endpoints require POST and send no email or OTP in a GET request', () => {
  const { context } = loadBackend();
  const getResponse = JSON.parse(context.doGet({
    parameter: { action: 'verifyOtp', email: 'test@example.com', otp: '123456' }
  }).text);

  assert.equal(getResponse.success, false);
  assert.match(getResponse.message, /Use POST/);
  const postResponse = JSON.parse(context.doPost({
    postData: {
      contents: JSON.stringify({
        action: 'verifyOtp',
        email: 'test@example.com',
        otp: '123456'
      })
    }
  }).text);
  assert.equal(postResponse.success, true);
});

test('audit summary is denied to ordinary users and available only to configured admins', () => {
  const ordinary = loadBackend();
  const ordinaryLogin = JSON.parse(ordinary.context.handleVerifyOtp('test@example.com', '123456').text);
  const denied = JSON.parse(ordinary.context.handleGetAuditSummary(
    'test@example.com', ordinaryLogin.sessionToken
  ).text);
  assert.equal(denied.success, false);
  assert.match(denied.message, /Administrator access/);

  const admin = loadBackend({ admins: 'admin@example.com' });
  admin.cache.set('OTP_admin@example.com', '123456');
  const adminLogin = JSON.parse(admin.context.handleVerifyOtp('admin@example.com', '123456').text);
  const allowed = JSON.parse(admin.context.handleGetAuditSummary(
    'admin@example.com', adminLogin.sessionToken
  ).text);
  assert.equal(adminLogin.isAdmin, true);
  assert.equal(allowed.success, true);
});

test('payment reference reuse is rejected across accounts and audit omits payer names', () => {
  const { context, sheets, cache } = loadBackend();
  const firstLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  const first = JSON.parse(context.handleSubmitPayment(
    'test@example.com', firstLogin.sessionToken, 'Bronze', 'REF-123', 'Payer One'
  ).text);
  assert.equal(first.success, true);
  assert.equal(sheets.Payment_Audit.rows[1][5], '');

  cache.set('OTP_other@example.com', '654321');
  const secondLogin = JSON.parse(context.handleVerifyOtp('other@example.com', '654321').text);
  const duplicate = JSON.parse(context.handleSubmitPayment(
    'other@example.com', secondLogin.sessionToken, 'Silver', 'ref-123', 'Payer Two'
  ).text);
  assert.equal(duplicate.success, false);
  assert.match(duplicate.message, /already been submitted/i);
  assert.equal(sheets.GCash_Payments.rows.length, 2);
});

test('payment submission enforces paid capacity on the server', () => {
  const { context, sheets } = loadBackend();
  context.MAX_ACTIVE_PAID_USERS = 1;
  const login = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  sheets.Users.appendRow([
    'USR_OTHER',
    'other@example.com',
    new Date(),
    'Bronze',
    new Date(Date.now() + 86400000),
    0,
    '2026-11-09',
    ''
  ]);

  const response = JSON.parse(context.handleSubmitPayment(
    'test@example.com', login.sessionToken, 'Bronze', 'REF-CAPACITY', 'Payer'
  ).text);

  assert.equal(response.success, false);
  assert.equal(response.capacityFull, true);
  assert.equal(sheets.GCash_Payments.rows.length, 1);
});

test('manual rejection is recorded once with the available reviewer identity', () => {
  const { context, sheets } = loadBackend({ admins: 'reviewer@example.com' });
  const login = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  context.handleSubmitPayment(
    'test@example.com', login.sessionToken, 'Bronze', 'REF-456', 'Payer'
  );
  sheets.GCash_Payments.rows[1][4] = 'Rejected - receipt mismatch';
  const sheetFacade = {
    getName: () => 'GCash_Payments',
    getRange: (...args) => sheets.GCash_Payments.getRange(...args)
  };
  const event = {
    range: {
      getSheet: () => sheetFacade,
      getRow: () => 2,
      getColumn: () => 5,
      getValue: () => 'Rejected - receipt mismatch'
    },
    user: { getEmail: () => 'reviewer@example.com' }
  };

  context.handlePaymentStatusEdit(event);
  context.handlePaymentStatusEdit(event);

  assert.equal(sheets.Payment_Audit.rows.length, 3);
  assert.equal(sheets.Payment_Audit.rows[2][1], 'payment_rejected');
  assert.equal(sheets.Payment_Audit.rows[2][8], 'reviewer@example.com');
});

test('payment review changes from non-admin editors are reverted', () => {
  const { context, sheets } = loadBackend();
  const login = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  context.handleSubmitPayment(
    'test@example.com', login.sessionToken, 'Bronze', 'REF-789', 'Payer'
  );
  sheets.GCash_Payments.rows[1][4] = 'Verified';
  const sheetFacade = {
    getName: () => 'GCash_Payments',
    getRange: (...args) => sheets.GCash_Payments.getRange(...args)
  };
  const event = {
    range: {
      getSheet: () => sheetFacade,
      getRow: () => 2,
      getColumn: () => 5,
      getValue: () => 'Verified'
    },
    user: { getEmail: () => 'untrusted@example.com' }
  };

  context.handlePaymentStatusEdit(event);

  assert.equal(sheets.GCash_Payments.rows[1][4], 'Pending');
  assert.equal(sheets.Payment_Audit.rows[2][1], 'payment_review_denied');
  assert.equal(sheets.Payment_Audit.rows[2][8], 'untrusted@example.com');
});

test('sign-out revokes only the current server session', () => {
  const { context, cache } = loadBackend();
  const firstLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  cache.set('OTP_test@example.com', '654321');
  const secondLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '654321').text);

  const revoked = JSON.parse(context.handleRevokeSession(
    'test@example.com', firstLogin.sessionToken
  ).text);
  assert.equal(revoked.success, true);
  assert.throws(
    () => context.handleValidateSession('test@example.com', firstLogin.sessionToken),
    /saved session is no longer valid/
  );
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', secondLogin.sessionToken).text).success,
    true
  );
});

test('daily search allowance consumption cannot exceed the configured limit', () => {
  const { context, sheets } = loadBackend();
  context.handleVerifyOtp('test@example.com', '123456');
  const userRow = 2;

  assert.equal(context.consumeSearchAllowance_(
    sheets.Users, userRow, 'Free', 3, '2026-11-09'
  ).allowed, true);
  assert.equal(context.consumeSearchAllowance_(
    sheets.Users, userRow, 'Free', 3, '2026-11-09'
  ).allowed, true);
  assert.equal(context.consumeSearchAllowance_(
    sheets.Users, userRow, 'Free', 3, '2026-11-09'
  ).allowed, true);
  assert.equal(context.consumeSearchAllowance_(
    sheets.Users, userRow, 'Free', 3, '2026-11-09'
  ).allowed, false);
  assert.equal(sheets.Users.rows[userRow - 1][5], 3);
});

test('free-tier search limits only show paid options on the final trial day', () => {
  for (const daysSinceJoined of [1, 2]) {
    const { context, sheets } = loadBackend();
    const verification = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
    const user = sheets.Users.rows[1];
    user[2] = new Date(Date.now() - (daysSinceJoined - 1) * 24 * 60 * 60 * 1000);
    user[3] = 'Free';
    user[5] = 3;
    user[6] = new Date().toISOString().slice(0, 10);

    const result = JSON.parse(
      context.handleSearch('test@example.com', verification.sessionToken, '', '').text
    );
    assert.equal(result.dailyLimitReached, true);
    assert.equal(result.paywallRequired, false);
    assert.equal(
      result.message,
      'You have reached your daily limit of 3 searches for the Free tier. Please try again tomorrow. Or upgrade your tier.'
    );
  }

  const { context, sheets } = loadBackend();
  const verification = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  const user = sheets.Users.rows[1];
  user[2] = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  user[3] = 'Free';
  user[5] = 3;
  user[6] = new Date().toISOString().slice(0, 10);

  const result = JSON.parse(
    context.handleSearch('test@example.com', verification.sessionToken, '', '').text
  );
  assert.equal(result.dailyLimitReached, true);
  assert.equal(result.paywallRequired, true);
  assert.match(result.message, /free trial ends today/i);
});

test('an expired free trial requires a paid tier', () => {
  const { context, sheets } = loadBackend();
  const verification = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  const user = sheets.Users.rows[1];
  user[2] = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  user[3] = 'Free';

  const result = JSON.parse(
    context.handleSearch('test@example.com', verification.sessionToken, '', '').text
  );
  assert.equal(result.success, false);
  assert.equal(result.paywallRequired, true);
  assert.match(result.message, /trial has expired/i);
});

test('search normalizes duplicate URLs and uses details as a fallback before applying the result limit', () => {
  const { context, sheets } = loadBackend();
  const verification = JSON.parse(context.handleVerifyOtp('test@example.com', '123456').text);
  sheets.Job_Listings.rows = [
    ['Title', 'Country', 'City', 'Employer', 'Priority', 'URL', 'Sponsorship', 'Notice'],
    ['Welder', 'France', 'Paris', 'Example Co', 'Priority 1', 'https://jobs.test/1', 'Match', 'Notice'],
    ['Welder', 'France', 'Paris', 'Example Co', 'Priority 1', 'https://jobs.test/1?source=feed', 'Match', 'Notice'],
    ['Welder', 'France', 'Paris', 'Example Co', 'Priority 1', 'https://jobs.test/duplicate', 'Match', 'Notice'],
    ['Welder', 'France', 'Paris', 'Example Co', 'Priority 1', '', 'Match', 'Notice'],
    ['Welder', 'France', 'Lyon', 'Example Co', 'Priority 2', 'https://jobs.test/2', 'Match', 'Notice']
  ];

  const result = JSON.parse(
    context.handleSearch('test@example.com', verification.sessionToken, 'welder', 'France').text
  );

  assert.equal(result.success, true);
  assert.equal(result.results.length, 3);
  assert.deepEqual(
    Array.from(result.results, job => job.officialApplyUrl),
    ['https://jobs.test/1', 'https://jobs.test/duplicate', 'https://jobs.test/2']
  );
});
