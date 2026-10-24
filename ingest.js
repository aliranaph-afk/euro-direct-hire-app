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

// GENERIC REGIONAL SEARCH HELPER
async function fetchJobsForRegion(countryName, searchQuery, defaultCity) {
  console.log(`Fetching live jobs for ${countryName}...`);
  try {
    const response = await fetch(`https://jobsearch.api.jobtechdev.se/search?q=${encodeURIComponent(searchQuery)}&limit=3`);
    const data = await response.json();
    const rows = [];
    
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || `${countryName} Direct Employer`;
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;
      
      const isSkilled = /cnc|welder|engineer|machinist|technician|developer/i.test(hit.headline);
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
    // 1. Existing European & Nordic targets
    const swedenJobs = await fetchJobsForRegion('Sweden', 'welder cnc', 'Sweden');
    const finlandJobs = await fetchJobsForRegion('Finland', 'finland welder machinist', 'Helsinki');
    
    // 2. New requested targets
    const irelandJobs = await fetchJobsForRegion('Ireland', 'ireland engineer technician', 'Dublin');
    const scotlandJobs = await fetchJobsForRegion('Scotland', 'scotland welder engineer', 'Glasgow');
    const canadaJobs = await fetchJobsForRegion('Canada', 'canada welder technician', 'Toronto');

    const allJobs = [
      ...swedenJobs, 
      ...finlandJobs, 
      ...irelandJobs, 
      ...scotlandJobs, 
      ...canadaJobs
    ];

    if (allJobs.length === 0) {
      console.log('No jobs found.');
      return;
    }

    console.log(`Appending ${allJobs.length} target jobs to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully updated sheet!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();