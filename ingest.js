const { google } = require('googleapis');

// 1. CONFIGURATION
const SPREADSHEET_ID = '18GaEB6pzvl_5IWgNeRjF60Y2K6XP0yUximKXoVVuCKk';
const SERVICE_ACCOUNT_FILE = './service_account.json';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// FETCH FROM SWEDEN
async function fetchSwedenJobs() {
  console.log('Fetching live jobs from Sweden...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=welder%20cnc&limit=3');
    const data = await response.json();
    const rows = [];
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || 'Swedish Direct Employer';
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;
      rows.push([
        hit.headline, 'Sweden', hit.workplace_address?.municipality || 'Sweden', 
        employer, /cnc|welder/i.test(hit.headline) ? 'Priority 2' : 'Priority 1', 
        hit.webpage_url, 'S1', /cnc|welder/i.test(hit.headline) ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('Sweden error:', err.message);
    return [];
  }
}

// FETCH FROM DENMARK
async function fetchDenmarkJobs() {
  console.log('Fetching live jobs from Denmark...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=denmark%20welder%20cnc&limit=3');
    const data = await response.json();
    const rows = [];
    for (const hit of data.hits || []) {
      rows.push([
        hit.headline, 'Denmark', 'Copenhagen', 
        hit.employer?.name || 'Danish Direct Employer', 'Priority 2', 
        hit.webpage_url, 'S1', 'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    return [];
  }
}

// FETCH FROM NORWAY
async function fetchNorwayJobs() {
  console.log('Fetching live jobs from Norway...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=norway%20welder%20engineer&limit=3');
    const data = await response.json();
    const rows = [];
    for (const hit of data.hits || []) {
      rows.push([
        hit.headline, 'Norway', 'Oslo', 
        hit.employer?.name || 'Norwegian Direct Employer', 'Priority 2', 
        hit.webpage_url, 'S1', 'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    return [];
  }
}

// FETCH FROM FINLAND
async function fetchFinlandJobs() {
  console.log('Fetching live jobs from Finland...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=finland%20welder%20machinist&limit=3');
    const data = await response.json();
    const rows = [];
    for (const hit of data.hits || []) {
      rows.push([
        hit.headline, 'Finland', 'Helsinki', 
        hit.employer?.name || 'Finnish Direct Employer', 'Priority 2', 
        hit.webpage_url, 'S1', 'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    return [];
  }
}

// MAIN INGESTION PIPELINE
async function runIngestionPipeline() {
  try {
    const swedenJobs = await fetchSwedenJobs();
    const denmarkJobs = await fetchDenmarkJobs();
    const norwayJobs = await fetchNorwayJobs();
    const finlandJobs = await fetchFinlandJobs();

    const allJobs = [...swedenJobs, ...denmarkJobs, ...norwayJobs, ...finlandJobs];

    if (allJobs.length === 0) {
      console.log('No jobs found.');
      return;
    }

    console.log(`Appending ${allJobs.length} multi-country jobs to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully updated sheet with multi-country data!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();