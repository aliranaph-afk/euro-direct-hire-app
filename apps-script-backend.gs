/**
 * EURO-DIRECT HIRE BACKEND API (Google Apps Script)
 * Sheet Tabs: Job_Listings, Users, GCash_Payments
 */

var MAX_ACTIVE_PAID_USERS = 200;
var PAID_TIERS = {
  Bronze: 7,
  Silver: 14,
  Gold: 21
};

function doGet(e) {
  var params = e.parameter;
  var action = params.action;

  try {
    if (action === "sendOtp") {
      return handleSendOtp(params.email);
    }
    if (action === "verifyOtp") {
      return handleVerifyOtp(params.email, params.otp);
    }
    if (action === "validateSession") {
      return handleValidateSession(params.email, params.token);
    }
    if (action === "search") {
      return handleSearch(params.email, params.token, params.position, params.country);
    }
    if (action === "suggestJobTitles") {
      return handleSuggestJobTitles(params.email, params.token, params.query);
    }
    if (action === "checkPaidCapacity") {
      return handlePaidCapacityCheck(params.email, params.token);
    }
    return responseJSON({ success: false, message: "Invalid API action" });
  } catch (err) {
    return responseJSON({ success: false, message: err.toString() });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === "validateSession") {
      return handleValidateSession(data.email, data.token);
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
    return responseJSON({ success: false, message: "Invalid POST action" });
  } catch (err) {
    return responseJSON({ success: false, message: err.toString() });
  }
}

function handleSendOtp(email) {
  if (!email) return responseJSON({ success: false, message: "Email is required" });

  var cleanEmail = email.trim().toLowerCase();
  var otp = Math.floor(100000 + Math.random() * 900000).toString();
  CacheService.getScriptCache().put("OTP_" + cleanEmail, otp, 600);

  var subject = "Your Verification Code - EuroDirect Jobs";
  var body = "Mabuhay!\n\nYour 6-digit verification code is: " + otp +
    "\n\nThis code will expire in 10 minutes.\n\nThank you!";
  GmailApp.sendEmail(cleanEmail, subject, body);
  return responseJSON({ success: true, message: "OTP sent to " + cleanEmail });
}

function handleVerifyOtp(email, inputOtp) {
  if (!email || !inputOtp) {
    return responseJSON({ success: false, message: "Email and OTP are required" });
  }

  var cleanEmail = email.trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var cachedOtp = cache.get("OTP_" + cleanEmail);

  if (cachedOtp && cachedOtp === inputOtp.trim()) {
    cache.remove("OTP_" + cleanEmail);
    var user = getOrCreateUser(cleanEmail);
    var sessionToken = Utilities.getUuid() + Utilities.getUuid();
    var userSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Users");
    var sessionHeader = userSheet.getRange(1, 8).getValue();
    if (!sessionHeader || sessionHeader === "Session Token Hash") {
      userSheet.getRange(1, 8).setValue("Session Token Hashes");
    }
    var sessionHashes = getSessionTokenHashes_(userSheet.getRange(user.rowIndex, 8).getValue());
    sessionHashes.push(hashSessionToken_(sessionToken));
    userSheet.getRange(user.rowIndex, 8).setValue("v1:" + sessionHashes.join(","));
    return responseJSON({
      success: true,
      message: "Email verified successfully",
      email: cleanEmail,
      sessionToken: sessionToken
    });
  }
  return responseJSON({ success: false, message: "Invalid or expired OTP code" });
}

function hashSessionToken_(token) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    token,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(digest);
}

function getSessionTokenHashes_(storedValue) {
  var stored = String(storedValue || "");
  if (!stored) return [];
  if (stored.indexOf("v1:") === 0) {
    return stored.substring(3).split(",").filter(function(hash) { return hash !== ""; });
  }
  return [stored];
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
    var sessionHashes = getSessionTokenHashes_(data[i][7]);
    var tokenIsValid = sessionHashes.indexOf(tokenHash) !== -1;
    if (!tokenIsValid) {
      throw new Error("Your saved session is no longer valid. Please verify your email again.");
    }
    return getOrCreateUser(cleanEmail);
  }
  throw new Error("Your saved session is no longer valid. Please verify your email again.");
}

function handleValidateSession(email, token) {
  var user = getAuthenticatedUser_(email, token);
  return responseJSON({ success: true, email: user.email });
}

function handleSuggestJobTitles(email, token, query) {
  getAuthenticatedUser_(email, token);
  var cleanQuery = String(query || "").trim().toLowerCase();
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

function handleSearch(email, token, position, country) {
  if (!email) return responseJSON({ success: false, message: "Email is required" });

  var cleanEmail = email.trim().toLowerCase();
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
  var posQuery = (position || "").toLowerCase().trim();
  var countryQuery = (country || "").toLowerCase().trim();

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

  searchesToday++;
  userSheet.getRange(user.rowIndex, 4).setValue(user.activeTier);
  userSheet.getRange(user.rowIndex, 6).setValue(searchesToday);
  userSheet.getRange(user.rowIndex, 7).setValue(todayStr);

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

  var cleanEmail = email.trim().toLowerCase();
  var cleanRefNumber = String(refNumber).trim();
  var cleanPayerName = String(payerName).trim();
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
    return responseJSON({
      success: true,
      message: "Payment submitted for manual review. Please allow up to 24 hours for approval."
    });
  } finally {
    lock.releaseLock();
  }
}

function handlePaymentStatusEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  var rowIndex = e.range.getRow();
  if (sheet.getName() !== "GCash_Payments" || e.range.getColumn() !== 5 || rowIndex <= 1) return;
  if (String(e.range.getValue()).trim() !== "Verified") return;

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var rowValues = sheet.getRange(rowIndex, 1, 1, 7).getValues()[0];
    var userEmail = String(rowValues[1] || "").trim().toLowerCase();
    var selectedTier = String(rowValues[2] || "");
    var refNumber = String(rowValues[3] || "");
    if (rowValues[5] !== "") return;
    if (!Object.prototype.hasOwnProperty.call(PAID_TIERS, selectedTier)) {
      sheet.getRange(rowIndex, 5).setValue("Rejected - invalid tier");
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
      return;
    }

    var daysToAdd = PAID_TIERS[selectedTier];
    var expirationDate = new Date(now.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    userSheet.getRange(userRow, 4).setValue(selectedTier);
    userSheet.getRange(userRow, 5).setValue(expirationDate);

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
    var pendingEmails = getRecentPendingPaymentEmails_(paySheet, cutoff);
    var removedUsers = deleteExpiredUserRows_(userSheet, cutoff, now, pendingEmails);
    var removedPayments = deleteOldPaymentRows_(paySheet, cutoff);
    console.log("Privacy cleanup completed. Removed " + removedUsers +
      " user rows and " + removedPayments + " payment rows.");
  } finally {
    lock.releaseLock();
  }
}

function getRecentPendingPaymentEmails_(paySheet, cutoff) {
  var lastRow = paySheet.getLastRow();
  var pendingEmails = {};
  if (lastRow < 2) return pendingEmails;

  var rows = paySheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (var i = 0; i < rows.length; i++) {
    var submittedAt = rows[i][0] ? new Date(rows[i][0]) : null;
    var status = String(rows[i][4] || "").toLowerCase();
    var email = String(rows[i][1] || "").trim().toLowerCase();
    if (email && submittedAt && !isNaN(submittedAt.getTime()) &&
        submittedAt > cutoff && status.indexOf("pending") === 0) {
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
    if (!submittedAt || isNaN(submittedAt.getTime()) || submittedAt > cutoff) continue;
    paySheet.deleteRow(i + 2);
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
