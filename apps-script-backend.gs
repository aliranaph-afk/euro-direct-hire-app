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
    userSheet.getRange(userRow, 6).setValue(searchesToday);
    userSheet.getRange(userRow, 7).setValue(todayStr);
    return { allowed: true, searchesToday: searchesToday };
  } finally {
    lock.releaseLock();
  }
}

function handleSearch(email, token, position, country) {
  if (!email) return responseJSON({ success: false, message: "Email is required" });

  var cleanEmail = normalizeEmail_(email);
  if (!isValidEmailAddress_(cleanEmail)) {
    return responseJSON({ success: false, message: "Please enter a valid email address." });
  }

  var safePosition = sanitizeText_(position, MAX_SEARCH_TERM_LENGTH);
  var safeCountry = sanitizeText_(country, MAX_SEARCH_TERM_LENGTH);
  var user = getAuthenticatedUser_(cleanEmail, token);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userSheet = ss.getSheetByName("Users");
  var now = new Date();
  var todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");
  var diffTime = Math.max(0, now - user.firstSeenDate);
  var daysSinceJoined = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
  var searchesToday = user.searchesToday;

  if (user.lastSearchDate !== todayStr) searchesToday = 0;

  var allowedResults = 0;
  var isExpired = false;
  if (user.activeTier !== "Free" &&
      (!PAID_TIERS[user.activeTier] ||
       !user.tierExpirationDate ||
       isNaN(user.tierExpirationDate.getTime()) ||
       now >= user.tierExpirationDate)) {
    user.activeTier = "Free";
  }

  if (user.activeTier === "Free") {
    if (daysSinceJoined > 3) {
      isExpired = true;
    } else {
      allowedResults = 3;
    }
  } else if (PAID_TIERS[user.activeTier]) {
    allowedResults = PAID_TIERS[user.activeTier];
  } else {
    user.activeTier = "Free";
    allowedResults = daysSinceJoined > 3 ? 0 : 3;
    isExpired = daysSinceJoined > 3;
  }

  if (isExpired) {
    return responseJSON({
      success: false,
      paywallRequired: true,
      message: "Your 3-day free trial has expired. Please choose a subscription tier to continue searching."
    });
  }

  if (searchesToday >= allowedResults) {
    var freeTrialLastDay = user.activeTier === "Free" && daysSinceJoined === 3;
    var limitMessage = "You have reached your daily limit of " + allowedResults +
      " searches for the " + (user.activeTier === "Free" ? "Free" : user.activeTier) +
      " tier. Please try again tomorrow.";
    if (freeTrialLastDay) {
      limitMessage = "You have reached your daily limit of " + allowedResults +
        " searches for the Free tier. Your free trial ends today. Choose a paid tier to continue searching.";
    } else if (user.activeTier === "Free") {
      limitMessage += " Or upgrade your tier.";
    }
    return responseJSON({
      success: false,
      dailyLimitReached: true,
      paywallRequired: freeTrialLastDay,
      message: limitMessage
    });
  }

  var jobSheet = ss.getSheetByName("Job_Listings");
  if (!jobSheet) throw new Error('Missing "Job_Listings" sheet.');
  var jobData = jobSheet.getDataRange().getValues();
  var matchingJobs = [];
  var seenListingUrls = {};
  var seenListingDetails = {};
  var posQuery = safePosition.toLowerCase().trim();
  var countryQuery = safeCountry.toLowerCase().trim();

  for (var i = 1; i < jobData.length; i++) {
    var titleValue = String(jobData[i][0] || "").trim();
    var countryValue = String(jobData[i][1] || "").trim();
    var cityValue = String(jobData[i][2] || "").trim();
    var employerValue = String(jobData[i][3] || "").trim();
    var title = titleValue.toLowerCase();
    var ctry = countryValue.toLowerCase();
    var matchesPos = posQuery === "" || title.indexOf(posQuery) !== -1;
    var matchesCountry = countryQuery === "" || ctry.indexOf(countryQuery) !== -1;

    if (matchesPos && matchesCountry) {
      var listingUrl = String(jobData[i][5] || "").trim();
      var normalizedUrl = listingUrl
        ? listingUrl.split("#")[0].split("?")[0].replace(/\/+$/, "").toLowerCase()
        : "";
      var normalizedDetails = [
        title,
        countryValue.toLowerCase(),
        cityValue.toLowerCase(),
        employerValue.toLowerCase()
      ].join("|");
      if (normalizedUrl ? seenListingUrls[normalizedUrl] : seenListingDetails[normalizedDetails]) continue;

      if (normalizedUrl) seenListingUrls[normalizedUrl] = true;
      seenListingDetails[normalizedDetails] = true;
      matchingJobs.push({
        jobTitle: titleValue,
        country: countryValue,
        cityOrRegion: cityValue,
        employerName: employerValue,
        priorityTier: jobData[i][4],
        officialApplyUrl: listingUrl,
        sponsorshipBadge: jobData[i][6],
        dmwNotice: jobData[i][7]
      });
      if (matchingJobs.length >= allowedResults) break;
    }
  }

  var usageResult = consumeSearchAllowance_(userSheet, user.rowIndex, user.activeTier, allowedResults, todayStr);
  if (!usageResult.allowed) {
    return responseJSON({
      success: false,
      dailyLimitReached: true,
      paywallRequired: user.activeTier === "Free" && daysSinceJoined === 3,
      message: "You have reached your daily limit of " + allowedResults +
        " searches for the " + (user.activeTier === "Free" ? "Free" : user.activeTier) +
        " tier. Please try again tomorrow."
    });
  }
  searchesToday = usageResult.searchesToday;

  return responseJSON({
    success: true,
    userTier: user.activeTier,
    daysJoined: daysSinceJoined,
    searchesUsedToday: searchesToday,
    dailyLimit: allowedResults,
    resultsCount: matchingJobs.length,
    results: matchingJobs
  });
}

function handleSubmitPayment(email, token, tier, refNumber, payerName) {
  if (!email || !tier || !refNumber || !payerName) {
    return responseJSON({ success: false, message: "Missing required payment parameters." });
  }
  getAuthenticatedUser_(email, token);
  if (!Object.prototype.hasOwnProperty.call(PAID_TIERS, tier)) {
    return responseJSON({ success: false, message: "Invalid subscription tier." });
  }

  var cleanEmail = normalizeEmail_(email);
  if (!isValidEmailAddress_(cleanEmail)) {
    return responseJSON({ success: false, message: "Please enter a valid email address." });
  }

  var cleanRefNumber = sanitizeText_(refNumber, MAX_FREEFORM_TEXT_LENGTH);
  var cleanPayerName = sanitizeText_(payerName, MAX_FREEFORM_TEXT_LENGTH);
  if (!cleanRefNumber || cleanRefNumber.length > 100 ||
      !cleanPayerName || cleanPayerName.length > 100) {
    return responseJSON({ success: false, message: "Enter a valid reference number and name (100 characters maximum)." });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var userSheet = ss.getSheetByName("Users");
    var paySheet = ss.getSheetByName("GCash_Payments");
    if (!userSheet || !paySheet) throw new Error("Required payment sheets are missing.");

    var now = new Date();
    if (hasPendingPaymentForEmail_(paySheet, cleanEmail)) {
      return responseJSON({
        success: true,
        paymentPending: true,
        message: "A payment application for this account is already pending review. Please allow up to 24 hours for approval."
      });
    }
    var alreadyPaid = isEmailCurrentlyPaid_(userSheet, cleanEmail, now);
    if (!alreadyPaid && countOccupiedPaidSlots_(userSheet, paySheet, now) >= MAX_ACTIVE_PAID_USERS) {
      return responseJSON({
        success: false,
        capacityFull: true,
        message: "Paid-plan capacity is currently full."
      });
    }
    if (hasPaymentReference_(paySheet, cleanRefNumber)) {
      return responseJSON({
        success: false,
        message: "That payment reference has already been submitted. Please check the number or contact support."
      });
    }
    if (!paySheet.getRange(1, 7).getValue()) {
      paySheet.getRange(1, 7).setValue("Your Name");
    }
    paySheet.appendRow([
      now,
      cleanEmail,
      tier,
      safeSheetText_(cleanRefNumber),
      "Pending",
      "",
      safeSheetText_(cleanPayerName)
    ]);
    logPaymentAuditEntry_(ss, {
      event: "payment_submitted",
      email: cleanEmail,
      tier: tier,
      reference: safeSheetText_(cleanRefNumber),
      status: "Pending",
      notes: "Awaiting manual review",
      actor: "Customer submission"
    });
    return responseJSON({
      success: true,
      message: "Payment submitted for manual review. Please allow up to 24 hours for approval."
    });
  } finally {
    lock.releaseLock();
  }
}

function logPaymentAuditEntry_(ss, entry) {
  var auditSheet = ss.getSheetByName("Payment_Audit");
  if (!auditSheet) {
    auditSheet = ss.insertSheet("Payment_Audit");
    auditSheet.getRange(1, 1, 1, 9).setValues([[
      "Timestamp",
      "Event",
      "Email",
      "Tier",
      "Reference",
      "Payer Name",
      "Status",
      "Notes",
      "Actor"
    ]]);
  }
  if (auditSheet.getRange(1, 9).getValue() !== "Actor") {
    auditSheet.getRange(1, 9).setValue("Actor");
  }
  var lastRow = auditSheet.getLastRow();
  var row = [
    new Date(),
    entry.event || "unknown",
    entry.email || "",
    entry.tier || "",
    entry.reference || "",
    "",
    entry.status || "",
    entry.notes || "",
    entry.actor || ""
  ];
  auditSheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);
}

function handlePaymentStatusEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  var rowIndex = e.range.getRow();
  if (sheet.getName() !== "GCash_Payments" || e.range.getColumn() !== 5 || rowIndex <= 1) return;
  var status = String(e.range.getValue()).trim();
  var isVerified = status === "Verified";
  var isRejected = status.toLowerCase().indexOf("rejected") === 0;
  if (!isVerified && !isRejected) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowValues = sheet.getRange(rowIndex, 1, 1, 7).getValues()[0];
    var userEmail = String(rowValues[1] || "").trim().toLowerCase();
    var selectedTier = String(rowValues[2] || "");
    var refNumber = String(rowValues[3] || "");
    var actorEmail = e.user && typeof e.user.getEmail === "function"
      ? normalizeEmail_(e.user.getEmail())
      : "";
    var actor = actorEmail || "Editor identity unavailable";
    if (!actorEmail || !isAdminEmail_(actorEmail)) {
      sheet.getRange(rowIndex, 5).setValue("Pending");
      logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
        event: "payment_review_denied",
        email: userEmail,
        tier: selectedTier,
        reference: refNumber,
        status: "Pending",
        notes: "Review change was reverted because the editor is not an authorized administrator.",
        actor: actor
      });
      return;
    }
    if (rowValues[5] !== "") return;
    if (isRejected) {
      sheet.getRange(rowIndex, 6).setValue(new Date());
      logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
        event: "payment_rejected",
        email: userEmail,
        tier: selectedTier,
        reference: refNumber,
        status: status,
        notes: "Payment application rejected during manual review.",
        actor: actor
      });
      return;
    }
    if (hasDuplicatePaymentReference_(sheet, refNumber, rowIndex)) {
      sheet.getRange(rowIndex, 5).setValue("Rejected - duplicate reference");
      logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
        event: "payment_rejected",
        email: userEmail,
        tier: selectedTier,
        reference: refNumber,
        status: "Rejected - duplicate reference",
        notes: "Manual review rejected because this payment reference appears on another submission.",
        actor: actor
      });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(PAID_TIERS, selectedTier)) {
      sheet.getRange(rowIndex, 5).setValue("Rejected - invalid tier");
      logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
        event: "payment_rejected",
        email: userEmail,
        tier: selectedTier,
        reference: refNumber,
        status: "Rejected - invalid tier",
        notes: "Manual review rejected because the selected tier is not valid.",
        actor: actor
      });
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var userSheet = ss.getSheetByName("Users");
    if (!userSheet) throw new Error('Missing "Users" sheet.');
    var now = new Date();

    var userData = userSheet.getDataRange().getValues();
    var userRow = 0;
    for (var i = 1; i < userData.length; i++) {
      if (String(userData[i][1]).trim().toLowerCase() === userEmail) {
        userRow = i + 1;
        break;
      }
    }
    if (!userRow) {
      sheet.getRange(rowIndex, 5).setValue("Rejected - account not found");
      logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
        event: "payment_rejected",
        email: userEmail,
        tier: selectedTier,
        reference: refNumber,
        status: "Rejected - account not found",
        notes: "Manual review rejected because the user account was not found.",
        actor: actor
      });
      return;
    }

    var daysToAdd = PAID_TIERS[selectedTier];
    var expirationDate = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    userSheet.getRange(userRow, 4).setValue(selectedTier);
    userSheet.getRange(userRow, 5).setValue(expirationDate);
    logPaymentAuditEntry_(SpreadsheetApp.getActiveSpreadsheet(), {
      event: "payment_verified",
      email: userEmail,
      tier: selectedTier,
      reference: refNumber,
      status: "Verified",
      notes: "Paid tier activated for " + daysToAdd + " days.",
      actor: actor
    });

    var siteUrl = "https://eurodirecthire.netlify.app/";
    var subject = "Payment Verified! Your " + selectedTier + " Tier is Active";
    var body = "Mabuhay!\n\nYour GCash payment (Ref: " + refNumber +
      ") has been approved and verified. Your selected " + selectedTier +
      " tier is now active.\n\nSubscription Details:\n- Tier: " + selectedTier +
      "\n- Valid For: " + daysToAdd + " Days\n- Expiration Date: " +
      Utilities.formatDate(expirationDate, Session.getScriptTimeZone(), "MMMM dd, yyyy") +
      "\n\nOpen EuroDirect-Hire here:\n" + siteUrl +
      "\n\nBest regards,\nEuroDirect Hire Team";
    var expiryText = Utilities.formatDate(expirationDate, Session.getScriptTimeZone(), "MMMM dd, yyyy");
    var htmlBody = "<p>Mabuhay!</p><p>Your GCash payment has been approved and verified. Your selected " +
      selectedTier + " tier is now active.</p><ul><li>Tier: " + selectedTier +
      "</li><li>Valid for: " + daysToAdd + " days</li><li>Expires: " + expiryText +
      "</li></ul><p><a href=\"" + siteUrl + "\">Open EuroDirect-Hire</a></p>" +
      "<p>Best regards,<br>EuroDirect Hire Team</p>";
    GmailApp.sendEmail(userEmail, subject, body, { htmlBody: htmlBody });
    sheet.getRange(rowIndex, 6).setValue(new Date());
  } finally {
    lock.releaseLock();
  }
}

function safeSheetText_(value) {
  var text = String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function runPrivacyDataCleanup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var userSheet = ss.getSheetByName("Users");
    var paySheet = ss.getSheetByName("GCash_Payments");
    if (!userSheet || !paySheet) throw new Error("Required privacy cleanup sheets are missing.");

    var now = new Date();
    var cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    var pendingEmails = getPendingPaymentEmails_(paySheet);
    var removedUsers = deleteExpiredUserRows_(userSheet, cutoff, now, pendingEmails);
    var removedPayments = deleteOldPaymentRows_(paySheet, cutoff);
    var removedAudit = deleteOldAuditRows_(ss.getSheetByName("Payment_Audit"),
      new Date(now.getTime() - PAYMENT_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    console.log("Privacy cleanup completed. Removed " + removedUsers +
      " user rows, " + removedPayments + " payment rows, and " + removedAudit + " audit rows.");
  } finally {
    lock.releaseLock();
  }
}

function getPendingPaymentEmails_(paySheet) {
  var lastRow = paySheet.getLastRow();
  var pendingEmails = {};
  if (lastRow < 2) return pendingEmails;

  var rows = paySheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    var status = String(rows[i][4] || "").toLowerCase();
    var email = String(rows[i][1] || "").trim().toLowerCase();
    if (email && status.indexOf("pending") === 0) {
      pendingEmails[email] = true;
    }
  }
  return pendingEmails;
}

function deleteExpiredUserRows_(userSheet, cutoff, now, pendingEmails) {
  var lastRow = userSheet.getLastRow();
  if (lastRow < 2) return 0;
  var rows = userSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var deleted = 0;

  for (var i = rows.length - 1; i >= 0; i--) {
    var firstSeen = rows[i][2] ? new Date(rows[i][2]) : null;
    if (!firstSeen || isNaN(firstSeen.getTime()) || firstSeen > cutoff) continue;
    if (isActivePaidUser_(rows[i], now)) continue;
    if (pendingEmails[String(rows[i][1] || "").trim().toLowerCase()]) continue;
    userSheet.deleteRow(i + 2);
    deleted++;
  }
  return deleted;
}

function deleteOldPaymentRows_(paySheet, cutoff) {
  var lastRow = paySheet.getLastRow();
  if (lastRow < 2) return 0;
  var rows = paySheet.getRange(2, 1, lastRow - 1, 6).getValues();
  var deleted = 0;

  for (var i = rows.length - 1; i >= 0; i--) {
    var submittedAt = rows[i][0] ? new Date(rows[i][0]) : null;
    var status = String(rows[i][4] || "").trim().toLowerCase();
    if (!submittedAt || isNaN(submittedAt.getTime()) || submittedAt > cutoff ||
        status.indexOf("pending") === 0) continue;
    paySheet.deleteRow(i + 2);
    deleted++;
  }
  return deleted;
}

function deleteOldAuditRows_(auditSheet, cutoff) {
  if (!auditSheet) return 0;
  var lastRow = auditSheet.getLastRow();
  if (lastRow < 2) return 0;
  var rows = auditSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var deleted = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    var timestamp = rows[i][0] ? new Date(rows[i][0]) : null;
    if (!timestamp || isNaN(timestamp.getTime()) || timestamp > cutoff) continue;
    auditSheet.deleteRow(i + 2);
    deleted++;
  }
  return deleted;
}

// Run once from the Apps Script editor to authorize and install both triggers.
function installBackendTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var handler = triggers[i].getHandlerFunction();
    if (handler === "runPrivacyDataCleanup" ||
        handler === "handlePaymentStatusEdit" ||
        handler === "onEdit") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger("handlePaymentStatusEdit")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();

  ScriptApp.newTrigger("runPrivacyDataCleanup")
    .timeBased()
    .everyHours(6)
    .create();
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
