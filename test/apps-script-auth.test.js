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
    getRange(row, column) {
      return {
        getValue: () => this.rows[row - 1]?.[column - 1] || "",
        setValue: value => {
          while (this.rows.length < row) this.rows.push([]);
          while (this.rows[row - 1].length < column) this.rows[row - 1].push("");
          this.rows[row - 1][column - 1] = value;
        }
      };
    }
  };
}

function loadBackend() {
  const cache = new Map([["OTP_test@example.com", "123456"]]);
  const sheets = {
    Users: createSheet([["User ID", "Email", "First Seen", "Tier", "Expiration", "Searches", "Last Search"]]),
    Job_Listings: createSheet([
      ["Title", "Country"],
      ["Welder", "France"],
      ["Senior Welder", "France"],
      ["welder", "Sweden"],
      ["CNC Operator", "Finland"]
    ])
  };
  let uuid = 0;
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
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: name => sheets[name] || null
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
  return { context, sheets, cache };
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

test('adding a session preserves legacy single-token hashes', () => {
  const { context, sheets, cache } = loadBackend();
  context.handleVerifyOtp('test@example.com', '123456');
  const existingToken = 'legacy-session-token';
  sheets.Users.rows[1][7] = context.hashSessionToken_(existingToken);
  cache.set('OTP_test@example.com', '654321');

  const newLogin = JSON.parse(context.handleVerifyOtp('test@example.com', '654321').text);

  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', existingToken).text).success,
    true
  );
  assert.equal(
    JSON.parse(context.handleValidateSession('test@example.com', newLogin.sessionToken).text).success,
    true
  );
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
