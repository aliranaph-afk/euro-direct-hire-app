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
      
      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician/i.test(hit.headline);
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
    // 18 Target Countries Pipeline
    const swedenJobs = await fetchJobsForRegion('Sweden', 'welder cnc', 'Sweden');
    const finlandJobs = await fetchJobsForRegion('Finland', 'finland welder machinist', 'Helsinki');
    const irelandJobs = await fetchJobsForRegion('Ireland', 'ireland engineer technician', 'Dublin');
    const scotlandJobs = await fetchJobsForRegion('Scotland', 'scotland welder engineer', 'Glasgow');
    const canadaJobs = await fetchJobsForRegion('Canada', 'canada welder technician', 'Toronto');
    const hungaryJobs = await fetchJobsForRegion('Hungary', 'hungary engineer operator', 'Budapest');
    const czechJobs = await fetchJobsForRegion('Czech Republic', 'czech welder machinist', 'Prague');
    const slovakiaJobs = await fetchJobsForRegion('Slovakia', 'slovakia technician assembly', 'Bratislava');
    const croatiaJobs = await fetchJobsForRegion('Croatia', 'croatia technician mechanic', 'Zagreb');
    const luxembourgJobs = await fetchJobsForRegion('Luxembourg', 'luxembourg engineer developer', 'Luxembourg City');
    const germanyJobs = await fetchJobsForRegion('Germany', 'germany CNC welder technician', 'Berlin');
    const austriaJobs = await fetchJobsForRegion('Austria', 'austria engineer welder', 'Vienna');
    const nzJobs = await fetchJobsForRegion('New Zealand', 'new zealand welder technician', 'Auckland');
    
    // New additions:
    const polandJobs = await fetchJobsForRegion('Poland', 'poland welder machinist operator', 'Warsaw');
    const romaniaJobs = await fetchJobsForRegion('Romania', 'romania welder mechanic technician', 'Bucharest');
    const japanJobs = await fetchJobsForRegion('Japan', 'japan engineer technician operator', 'Tokyo');
    const ukJobs = await fetchJobsForRegion('United Kingdom', 'uk welder engineer technician', 'London');
    const singaporeJobs = await fetchJobsForRegion('Singapore', 'singapore engineer technician machinist', 'Singapore');

    const allJobs = [
      ...swedenJobs, ...finlandJobs, ...irelandJobs, ...scotlandJobs, ...canadaJobs,
      ...hungaryJobs, ...czechJobs, ...slovakiaJobs, ...croatiaJobs, ...luxembourgJobs,
      ...germanyJobs, ...austriaJobs, ...nzJobs, ...polandJobs, ...romaniaJobs, 
      ...japanJobs, ...ukJobs, ...singaporeJobs
    ];

    if (allJobs.length === 0) {
      console.log('No jobs found.');
      return;
    }

    console.log(`Appending ${allJobs.length} jobs across 18 target countries to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully updated sheet with 18 target countries!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();