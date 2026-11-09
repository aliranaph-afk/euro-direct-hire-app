/**
 * EURO-DIRECT HIRE BACKEND API (Google Apps Script)
 * Sheet Tabs: Job_Listings, Users, GCash_Payments
 */

var MAX_ACTIVE_PAID_USERS = 200;
var SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var MAX_ACTIVE_SESSIONS_PER_USER = 10;
var OTP_MAX_REQUESTS_PER_WINDOW = 3;
var OTP_REQUEST_WINDOW_MS = 60 * 1000;
var OTP_LOCKOUT_MS = 5 * 60 * 1000;
var OTP_CODE_LENGTH = 6;
var MAX_FREEFORM_TEXT_LENGTH = 120;
var MAX_SEARCH_TERM_LENGTH = 80;
var MAX_REQUEST_BODY_LENGTH = 10000;
var PAYMENT_AUDIT_RETENTION_DAYS = 365;
var PAID_TIERS = {
  Bronze: 7,
  Silver: 14,
  Gold: 21
};

function normalizeEmail_(email) {
  return String(email || "").trim().toLowerCase();
}

function getAdminEmails_() {
  var configured = PropertiesService.getScriptProperties().getProperty("ADMIN_EMAILS") || "";
  return configured.split(",").map(normalizeEmail_).filter(isValidEmailAddress_);
}

function isAdminEmail_(email) {
  var cleanEmail = normalizeEmail_(email);
  return getAdminEmails_().indexOf(cleanEmail) !== -1;
}

function isValidEmailAddress_(email) {
  var cleanEmail = normalizeEmail_(email);
  if (!cleanEmail || cleanEmail.length > 254) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(cleanEmail);
}

function sanitizeText_(value, maxLength) {
  var text = String(value == null ? "" : value).replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  if (text.length > maxLength) {
    text = text.substring(0, maxLength).trim();
  }
  return text;
}

function getRateLimitState_(cacheKey, ttlMs) {
  var cache = CacheService.getScriptCache();
  var raw = cache.get(cacheKey);
  var now = Date.now();
  var state = { windowStart: now, count: 0 };
  if (raw) {
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed.windowStart === "number" && typeof parsed.count === "number") {
        state = parsed;
      }
    } catch (e) {
      state = { windowStart: now, count: 0 };
    }
  }
  if (now - state.windowStart > ttlMs) {
    state = { windowStart: now, count: 0 };
  }
  return state;
}

function generateSecureOtp_() {
  var payload = Utilities.getUuid() + "-" + Date.now().toString();
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    payload,
    Utilities.Charset.UTF_8
  );
  var otp = "";
  for (var i = 0; i < digest.length && otp.length < OTP_CODE_LENGTH; i++) {
    otp += String(Math.abs(digest[i]) % 10);
  }
  while (otp.length < OTP_CODE_LENGTH) {
    otp += "0";
  }
  return otp.substring(0, OTP_CODE_LENGTH);
}

function doGet(e) {
  return responseJSON({ success: false, message: "Use POST for API requests." });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return responseJSON({ success: false, message: "Invalid request payload." });
    }
    if (e.postData.contents.length > MAX_REQUEST_BODY_LENGTH) {
      return responseJSON({ success: false, message: "Request payload is too large." });
    }
    var data = JSON.parse(e.postData.contents);
    if (!data || !data.action) {
      return responseJSON({ success: false, message: "Invalid POST action" });
    }
    if (data.action === "sendOtp") {
      return handleSendOtp(data.email);
    }
    if (data.action === "verifyOtp") {
      return handleVerifyOtp(data.email, data.otp);
    }
    if (data.action === "validateSession") {
      return handleValidateSession(data.email, data.token);
    }
    if (data.action === "revokeSession") {
      return handleRevokeSession(data.email, data.token);
    }
    if (data.action === "search") {
      return handleSearch(data.email, data.token, data.position, data.country);
    }
    if (data.action === "suggestJobTitles") {
      return handleSuggestJobTitles(data.email, data.token, data.query);
    }
    if (data.action === "checkPaidCapacity") {
      return handlePaidCapacityCheck(data.email, data.token);
    }
    if (data.action === "submitPayment") {
      return handleSubmitPayment(data.email, data.token, data.tier, data.refNumber, data.payerName);
    }
    if (data.action === "getAuditSummary") {
      return handleGetAuditSummary(data.email, data.token);
    }
    return responseJSON({ success: false, message: "Invalid POST action" });
  } catch (err) {
    var errorText = String(err && err.message ? err.message : err);
    if (errorText.indexOf("JSON") !== -1 || errorText.indexOf("Unexpected") !== -1 || errorText.indexOf("Syntax") !== -1) {
      return responseJSON({ success: false, message: "Invalid request payload." });
    }
    if (errorText.indexOf("Please verify your email") === 0 ||
        errorText.indexOf("Your saved session is no longer valid") === 0) {
      return responseJSON({ success: false, message: errorText });
    }
    console.error("API request failed: " + errorText);
    return responseJSON({ success: false, message: "The request could not be completed." });
  }
}

function handleSendOtp(email) {
  var cleanEmail = normalizeEmail_(email);
  if (!isValidEmailAddress_(cleanEmail)) return responseJSON({ success: false, message: "Please enter a valid email address." });

  var cache = CacheService.getScriptCache();
  var rateKey = "OTP_RATE_" + cleanEmail;
  var lockKey = "OTP_LOCK_" + cleanEmail;
  var otp = "";
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (cache.get(lockKey)) {
      return responseJSON({ success: false, message: "Too many verification requests. Please try again in a few minutes." });
    }
    var rateState = getRateLimitState_(rateKey, OTP_REQUEST_WINDOW_MS);
    if (rateState.count >= OTP_MAX_REQUESTS_PER_WINDOW) {
      cache.put(lockKey, "1", Math.ceil(OTP_LOCKOUT_MS / 1000));
      console.warn("Security event: OTP send lockout triggered.");
      return responseJSON({ success: false, message: "Too many verification requests. Please try again in a few minutes." });
    }
    rateState.count += 1;
    cache.put(rateKey, JSON.stringify(rateState), Math.ceil(OTP_REQUEST_WINDOW_MS / 1000));
    otp = generateSecureOtp_();
    cache.put("OTP_" + cleanEmail, otp, 600);
  } finally {
    lock.releaseLock();
  }

  var subject = "Your Verification Code - EuroDirect Jobs";
  var body = "Mabuhay!\n\nYour 6-digit verification code is: " + otp +
    "\n\nThis code will expire in 10 minutes.\n\nThank you!";
  GmailApp.sendEmail(cleanEmail, subject, body);
  return responseJSON({ success: true, message: "OTP sent to " + cleanEmail });
}

function handleVerifyOtp(email, inputOtp) {
  var cleanEmail = normalizeEmail_(email);
  if (!isValidEmailAddress_(cleanEmail) || !String(inputOtp || "").trim()) {
    return responseJSON({ success: false, message: "Email and OTP are required" });
  }

  var otpValue = String(inputOtp).trim();
  if (!/^\d{6}$/.test(otpValue)) {
    return responseJSON({ success: false, message: "Please enter a valid 6-digit OTP." });
  }

  var cache = CacheService.getScriptCache();
  var lockKey = "OTP_LOCK_" + cleanEmail;
  var failureKey = "OTP_FAIL_" + cleanEmail;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (cache.get(lockKey)) {
      return responseJSON({ success: false, message: "This account is temporarily locked due to repeated failed attempts. Please try again later." });
    }

    var cachedOtp = cache.get("OTP_" + cleanEmail);
    if (cachedOtp && cachedOtp === otpValue) {
      cache.remove("OTP_" + cleanEmail);
      cache.remove(failureKey);
      var user = getOrCreateUser(cleanEmail);
      var sessionToken = Utilities.getUuid() + Utilities.getUuid();
      var userSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
      var sessionHeader = userSheet.getRange(1, 8).getValue();
      if (!sessionHeader || sessionHeader === "Session Token Hash") {
        userSheet.getRange(1, 8).setValue("Session Token Hashes");
      }
      var sessionEntries = getSessionTokenEntries_(userSheet.getRange(user.rowIndex, 8).getValue());
      var expiryTimestamp = Date.now() + SESSION_TOKEN_TTL_MS;
      sessionEntries.push({
        expiresAt: expiryTimestamp,
        hash: hashSessionToken_(sessionToken)
      });
      var activeEntries = pruneExpiredSessionEntries_(sessionEntries, Date.now());
      if (activeEntries.length > MAX_ACTIVE_SESSIONS_PER_USER) {
        activeEntries = activeEntries.slice(activeEntries.length - MAX_ACTIVE_SESSIONS_PER_USER);
      }
      userSheet.getRange(user.rowIndex, 8).setValue("v2:" + serializeSessionEntries_(activeEntries));
      return responseJSON({
        success: true,
        message: "Email verified successfully",
        email: cleanEmail,
        sessionToken: sessionToken,
        sessionExpiresAt: expiryTimestamp,
        isAdmin: isAdminEmail_(cleanEmail)
      });
    }

    var state = getRateLimitState_(failureKey, 10 * 60 * 1000);
    state.count += 1;
    cache.put(failureKey, JSON.stringify(state), Math.ceil((10 * 60 * 1000) / 1000));
    if (state.count >= 5) {
      cache.put(lockKey, "1", Math.ceil(OTP_LOCKOUT_MS / 1000));
      cache.remove("OTP_" + cleanEmail);
      console.warn("Security event: OTP verification lockout triggered.");
    }
    return responseJSON({ success: false, message: "Invalid or expired OTP code" });
  } finally {
    lock.releaseLock();
  }
}

function hashSessionToken_(token) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    token,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest);
}

function serializeSessionEntries_(entries) {
  return entries.map(function(entry) {
    if (entry && entry.expiresAt && entry.hash) {
      return String(entry.expiresAt) + ":" + entry.hash;
    }
    return String(entry && entry.hash ? entry.hash : "");
  }).filter(function(value) { return value !== ""; }).join(",");
}

function pruneExpiredSessionEntries_(entries, now) {
  return entries.filter(function(entry) {
    if (!entry || !entry.hash) return false;
    return Boolean(entry.expiresAt && Number(entry.expiresAt) > now);
  });
}

function getSessionTokenEntries_(storedValue) {
  var stored = String(storedValue || "");
  if (!stored) return [];

  if (stored.indexOf("v2:") === 0) {
    stored = stored.substring(3);
  } else if (stored.indexOf("v1:") === 0) {
    return stored.substring(3).split(",").filter(function(hash) { return hash !== ""; }).map(function(hash) {
      return { hash: hash, expiresAt: null };
    });
  }

  return stored.split(",").filter(function(item) { return item !== ""; }).map(function(item) {
    var parts = item.split(":");
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      return {
        expiresAt: Number(parts[0]),
        hash: parts.slice(1).join(":")
      };
    }
    return { hash: item, expiresAt: null };
  });
}

function getSessionTokenHashes_(storedValue) {
  var entries = getSessionTokenEntries_(storedValue);
  return entries.map(function(entry) { return entry.hash; }).filter(function(hash) { return hash !== ""; });
}

function getAuthenticatedUser_(email, token) {
  if (!email || !token) throw new Error("Please verify your email to continue.");

  var cleanEmail = String(email).trim().toLowerCase();
  var userSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
  if (!userSheet) throw new Error('Missing "Users" sheet.');

  var data = userSheet.getDataRange().getValues();
  var tokenHash = hashSessionToken_(String(token));
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toLowerCase() !== cleanEmail) continue;
    var sessionEntries = getSessionTokenEntries_(data[i][7]);
    var activeEntries = pruneExpiredSessionEntries_(sessionEntries, Date.now());
    var tokenIsValid = activeEntries.some(function(entry) {
      return entry.hash === tokenHash;
    });
    if (!tokenIsValid) {
      if (activeEntries.length !== sessionEntries.length) {
        userSheet.getRange(i + 1, 8).setValue("v2:" + serializeSessionEntries_(activeEntries));
      }
      throw new Error("Your saved session is no longer valid. Please verify your email again.");
    }
    if (activeEntries.length !== sessionEntries.length) {
      userSheet.getRange(i + 1, 8).setValue("v2:" + serializeSessionEntries_(activeEntries));
    }
    return getOrCreateUser(cleanEmail);
  }
  throw new Error("Your saved session is no longer valid. Please verify your email again.");
}

function handleValidateSession(email, token) {
  var user = getAuthenticatedUser_(email, token);
  return responseJSON({ success: true, email: user.email, isAdmin: isAdminEmail_(user.email) });
}

function handleRevokeSession(email, token) {
  var user = getAuthenticatedUser_(email, token);
  var userSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var storedValue = userSheet.getRange(user.rowIndex, 8).getValue();
    var tokenHash = hashSessionToken_(String(token));
    var remainingEntries = pruneExpiredSessionEntries_(getSessionTokenEntries_(storedValue), Date.now())
      .filter(function(entry) { return entry.hash !== tokenHash; });
    userSheet.getRange(user.rowIndex, 8).setValue("v2:" + serializeSessionEntries_(remainingEntries));
    return responseJSON({ success: true });
  } finally {
    lock.releaseLock();
  }
}

function handleSuggestJobTitles(email, token, query) {
  getAuthenticatedUser_(email, token);
  var cleanQuery = sanitizeText_(query, MAX_SEARCH_TERM_LENGTH).toLowerCase();
  if (cleanQuery.length < 2) return responseJSON({ success: true, suggestions: [] });

  var jobSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Job_Listings");
  if (!jobSheet) throw new Error('Missing "Job_Listings" sheet.');
  var jobData = jobSheet.getDataRange().getValues();
  var seen = {};
  var suggestions = [];

  for (var i = 1; i < jobData.length && suggestions.length < 8; i++) {
    var title = String(jobData[i][0] || "").trim();
    var normalizedTitle = title.toLowerCase();
    if (normalizedTitle.indexOf(cleanQuery) === -1 || seen[normalizedTitle]) continue;
    seen[normalizedTitle] = true;
    suggestions.push(title);
  }
  return responseJSON({ success: true, suggestions: suggestions });
}

function getOrCreateUser(email) {
  var userSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
  if (!userSheet) throw new Error('Missing "Users" sheet.');

  var data = userSheet.getDataRange().getValues();
  var now = new Date();
  var todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).toLowerCase() === email) {
      return {
        rowIndex: i + 1,
        userId: data[i][0],
        email: data[i][1],
        firstSeenDate: new Date(data[i][2]),
        activeTier: data[i][3],
        tierExpirationDate: data[i][4] ? new Date(data[i][4]) : null,
        searchesToday: Number(data[i][5]) || 0,
        lastSearchDate: data[i][6]
          ? Utilities.formatDate(new Date(data[i][6]), Session.getScriptTimeZone(), "yyyy-MM-dd")
          : ""
      };
    }
  }

  var userId = "USR_" + Utilities.getUuid();
  userSheet.appendRow([userId, email, now, "Free", "", 0, todayStr]);
  return {
    rowIndex: userSheet.getLastRow(),
    userId: userId,
    email: email,
    firstSeenDate: now,
    activeTier: "Free",
    tierExpirationDate: null,
    searchesToday: 0,
    lastSearchDate: todayStr
  };
}

function isActivePaidUser_(row, now) {
  var tier = String(row[3] || "");
  var expiration = row[4] ? new Date(row[4]) : null;
  return Boolean(PAID_TIERS[tier] && expiration && !isNaN(expiration.getTime()) && expiration > now);
}

function isEmailCurrentlyPaid_(userSheet, email, now) {
  var data = userSheet.getDataRange().getValues();
  var cleanEmail = email.toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]).trim().toLowerCase() === cleanEmail && isActivePaidUser_(data[i], now)) {
      return true;
    }
  }
  return false;
}

function hasPendingPaymentForEmail_(paySheet, email) {
  var lastRow = paySheet.getLastRow();
  if (lastRow < 2) return false;

  var cleanEmail = email.trim().toLowerCase();
  var rows = paySheet.getRange(2, 1, lastRow - 1, 5).getValues();
  for (var i = 0; i < rows.length; i++) {
    var rowEmail = String(rows[i][1] || "").trim().toLowerCase();
    var status = String(rows[i][4] || "").trim().toLowerCase();
    if (rowEmail === cleanEmail && status.indexOf("pending") === 0) return true;
  }
  return false;
}

function hasPaymentReference_(paySheet, reference) {
  var lastRow = paySheet.getLastRow();
  var normalizedReference = String(reference || "").trim();
  if (lastRow >= 2) {
    var rows = paySheet.getRange(2, 4, lastRow - 1, 1).getValues();
    for (var i = 0; i < rows.length; i++) {
      var storedReference = String(rows[i][0] || "").trim();
      if (storedReference.charAt(0) === "'" && /^[=+\-@]/.test(storedReference.substring(1))) {
        storedReference = storedReference.substring(1);
      }
      if (storedReference.toLowerCase() === normalizedReference.toLowerCase()) return true;
    }
  }

  var auditSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Payment_Audit");
  if (!auditSheet || auditSheet.getLastRow() < 2) return false;
  var auditReferences = auditSheet.getRange(2, 5, auditSheet.getLastRow() - 1, 1).getValues();
  for (var j = 0; j < auditReferences.length; j++) {
    var auditReference = String(auditReferences[j][0] || "").trim();
    if (auditReference.charAt(0) === "'" && /^[=+\-@]/.test(auditReference.substring(1))) {
      auditReference = auditReference.substring(1);
    }
    if (auditReference.toLowerCase() === normalizedReference.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function hasDuplicatePaymentReference_(paySheet, reference, excludedRow) {
  var lastRow = paySheet.getLastRow();
  if (lastRow < 2) return false;
  var normalizedReference = String(reference || "").trim().toLowerCase();
  var rows = paySheet.getRange(2, 4, lastRow - 1, 1).getValues();
  for (var i = 0; i < rows.length; i++) {
    var actualRow = i + 2;
    if (actualRow === excludedRow) continue;
    var storedReference = String(rows[i][0] || "").trim();
    if (storedReference.charAt(0) === "'" && /^[=+\-@]/.test(storedReference.substring(1))) {
      storedReference = storedReference.substring(1);
    }
    if (storedReference.toLowerCase() === normalizedReference) return true;
  }
  return false;
}

function countOccupiedPaidSlots_(userSheet, paySheet, now) {
  var occupiedEmails = {};
  var userData = userSheet.getDataRange().getValues();
  for (var i = 1; i < userData.length; i++) {
    var userEmail = String(userData[i][1] || "").trim().toLowerCase();
    if (userEmail && isActivePaidUser_(userData[i], now)) occupiedEmails[userEmail] = true;
  }

  var lastPaymentRow = paySheet.getLastRow();
  if (lastPaymentRow >= 2) {
    var paymentRows = paySheet.getRange(2, 1, lastPaymentRow - 1, 5).getValues();
    for (var j = 0; j < paymentRows.length; j++) {
      var pendingEmail = String(paymentRows[j][1] || "").trim().toLowerCase();
      var paymentStatus = String(paymentRows[j][4] || "").trim().toLowerCase();
      if (pendingEmail && paymentStatus.indexOf("pending") === 0) {
        occupiedEmails[pendingEmail] = true;
      }
    }
  }
  return Object.keys(occupiedEmails).length;
}

function handlePaidCapacityCheck(email, token) {
  if (!email) return responseJSON({ success: false, message: "Email is required" });
  getAuthenticatedUser_(email, token);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userSheet = ss.getSheetByName("Users");
  var paySheet = ss.getSheetByName("GCash_Payments");
  if (!userSheet || !paySheet) throw new Error("Required payment sheets are missing.");
  var now = new Date();
  var cleanEmail = email.trim().toLowerCase();
  var isAlreadyPaid = isEmailCurrentlyPaid_(userSheet, cleanEmail, now);
  var paymentPending = hasPendingPaymentForEmail_(paySheet, cleanEmail);
  return responseJSON({
    success: true,
    paymentPending: paymentPending,
    capacityFull: !isAlreadyPaid && !paymentPending &&
      countOccupiedPaidSlots_(userSheet, paySheet, now) >= MAX_ACTIVE_PAID_USERS
  });
}

function handleGetAuditSummary(email, token) {
  var user = getAuthenticatedUser_(email, token);
  if (!isAdminEmail_(user.email)) {
    return responseJSON({ success: false, message: "Administrator access is required." });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userSheet = ss.getSheetByName("Users");
  var paySheet = ss.getSheetByName("GCash_Payments");
  var auditSheet = ss.getSheetByName("Payment_Audit");
  var jobSheet = ss.getSheetByName("Job_Listings");
  var now = new Date();

  var userRows = [];
  if (userSheet) {
    userRows = userSheet.getDataRange().getValues();
  }

  var pendingPayments = 0;
  var verifiedPayments = 0;
  var rejectedPayments = 0;
  var activePaidUsers = 0;
  var totalUsers = Math.max(0, userRows.length - 1);

  for (var i = 1; i < userRows.length; i++) {
    if (isActivePaidUser_(userRows[i], now)) {
      activePaidUsers++;
    }
  }

  if (paySheet) {
    var payRows = paySheet.getDataRange().getValues();
    for (var j = 1; j < payRows.length; j++) {
      var status = String(payRows[j][4] || "").trim().toLowerCase();
      if (status.indexOf("pending") === 0) pendingPayments++;
      else if (status.indexOf("verified") === 0) verifiedPayments++;
      else if (status.indexOf("rejected") === 0 || status.indexOf("cancel") === 0) rejectedPayments++;
    }
  }

  var recentAudit = [];
  if (auditSheet) {
    var auditRows = auditSheet.getDataRange().getValues();
    for (var k = Math.max(1, auditRows.length - 10); k < auditRows.length; k++) {
      var auditTimestamp = auditRows[k][0] ? new Date(auditRows[k][0]) : null;
      recentAudit.push({
        timestamp: auditTimestamp && !isNaN(auditTimestamp.getTime()) ? auditTimestamp.toISOString() : "",
        event: auditRows[k][1] || "",
        email: auditRows[k][2] || "",
        tier: auditRows[k][3] || "",
        status: auditRows[k][6] || "",
        reference: auditRows[k][4] || "",
        note: auditRows[k][7] || "",
        actor: auditRows[k][8] || ""
      });
    }
  }

  var totalListings = jobSheet ? Math.max(0, jobSheet.getDataRange().getValues().length - 1) : 0;

  return responseJSON({
    success: true,
    summary: {
      totalUsers: totalUsers,
      activePaidUsers: activePaidUsers,
      pendingPayments: pendingPayments,
      verifiedPayments: verifiedPayments,
      rejectedPayments: rejectedPayments,
      totalListings: totalListings,
      recentAudit: recentAudit
    }
  });
}

function consumeSearchAllowance_(userSheet, userRow, tier, limit, todayStr) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var usage = userSheet.getRange(userRow, 6, 1, 2).getValues()[0];
    var searchesToday = Number(usage[0]) || 0;
    var lastSearchDate = usage[1]
      ? Utilities.formatDate(new Date(usage[1]), Session.getScriptTimeZone(), "yyyy-MM-dd")
      : "";
    if (lastSearchDate !== todayStr) searchesToday = 0;
    if (searchesToday >= limit) {
      return { allowed: false, searchesToday: searchesToday };
    }

    searchesToday++;
    userSheet.getRange(userRow, 4).setValue(tier);
