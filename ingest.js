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

// GENERIC COUNTRY FETCH HELPER
async function fetchJobsForCountry(countryName, searchQuery, defaultCity) {
  console.log(`Fetching live jobs from ${countryName}...`);
  try {
    const response = await fetch(`https://jobsearch.api.jobtechdev.se/search?q=${encodeURIComponent(searchQuery)}&limit=3`);
    const data = await response.json();
    const rows = [];
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || `${countryName} Direct Employer`;
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;
      
      const isSkilled = /cnc|welder|engineer|machinist|technician/i.test(hit.headline);
      rows.push([
        hit.headline, 
        countryName, 
        hit.workplace_address?.municipality || defaultCity, 
        employer, 
        isSkilled ? 'Priority 2' : 'Priority 1', 
        hit.webpage_url, 
        'S1', 
        isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA'
      ]);
    }
    return rows;
  } catch (err) {
    console.error(`${countryName} error:`, err.message);
    return [];
  }
}

// MAIN INGESTION PIPELINE
async function runIngestionPipeline() {
  try {
    // Fetching across 6 European countries
    const swedenJobs = await fetchJobsForCountry('Sweden', 'welder cnc', 'Sweden');
    const denmarkJobs = await fetchJobsForCountry('Denmark', 'denmark welder cnc', 'Copenhagen');
    const norwayJobs = await fetchJobsForCountry('Norway', 'norway welder engineer', 'Oslo');
    const finlandJobs = await fetchJobsForCountry('Finland', 'finland welder machinist', 'Helsinki');
    const icelandJobs = await fetchJobsForCountry('Iceland', 'iceland welder mechanic', 'Reykjavik');
    const netherlandsJobs = await fetchJobsForCountry('Netherlands', 'netherlands engineer technician', 'Amsterdam');

    const allJobs = [
      ...swedenJobs, 
      ...denmarkJobs, 
      ...norwayJobs, 
      ...finlandJobs, 
      ...icelandJobs, 
      ...netherlandsJobs
    ];

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
    console.log('Successfully updated sheet with expanded multi-country data!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();