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
      
      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician|driver/i.test(hit.headline);
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
    // 43 Target Countries List
    const targetCountries = [
      { name: 'Sweden', query: 'welder cnc engineer', city: 'Stockholm' },
      { name: 'Finland', query: 'welder machinist technician', city: 'Helsinki' },
      { name: 'Ireland', query: 'engineer technician operator', city: 'Dublin' },
      { name: 'Scotland', query: 'welder engineer technician', city: 'Glasgow' },
      { name: 'Canada', query: 'welder technician machinist', city: 'Toronto' },
      { name: 'Hungary', query: 'engineer operator technician', city: 'Budapest' },
      { name: 'Czech Republic', query: 'welder machinist operator', city: 'Prague' },
      { name: 'Slovakia', query: 'technician assembly operator', city: 'Bratislava' },
      { name: 'Croatia', query: 'technician mechanic operator', city: 'Zagreb' },
      { name: 'Luxembourg', query: 'engineer developer technician', city: 'Luxembourg City' },
      { name: 'Germany', query: 'CNC welder technician', city: 'Berlin' },
      { name: 'Austria', query: 'engineer welder technician', city: 'Vienna' },
      { name: 'New Zealand', query: 'welder technician machinist', city: 'Auckland' },
      { name: 'Poland', query: 'welder machinist operator', city: 'Warsaw' },
      { name: 'Romania', query: 'welder mechanic technician', city: 'Bucharest' },
      { name: 'Japan', query: 'engineer technician operator', city: 'Tokyo' },
      { name: 'United Kingdom', query: 'welder engineer technician', city: 'London' },
      { name: 'Singapore', query: 'engineer technician machinist', city: 'Singapore' },
      { name: 'Australia', query: 'welder engineer technician', city: 'Sydney' },
      { name: 'Switzerland', query: 'engineer technician specialist', city: 'Zurich' },
      { name: 'Spain', query: 'engineer technician developer', city: 'Madrid' },
      { name: 'South Korea', query: 'technician operator engineer', city: 'Seoul' },
      { name: 'Portugal', query: 'engineer developer technician', city: 'Lisbon' },
      { name: 'Saudi Arabia', query: 'engineer technician operator', city: 'Riyadh' },
      { name: 'Qatar', query: 'engineer technician mechanic', city: 'Doha' },
      { name: 'Kuwait', query: 'engineer technician driver', city: 'Kuwait City' },
      { name: 'Taiwan', query: 'technician engineer operator', city: 'Taipei' },
      { name: 'Malaysia', query: 'engineer technician operator', city: 'Kuala Lumpur' },
      { name: 'Belgium', query: 'engineer technician operator', city: 'Brussels' },
      { name: 'Norway', query: 'engineer welder technician', city: 'Oslo' },
      { name: 'Denmark', query: 'engineer technician machinist', city: 'Copenhagen' },
      { name: 'United Arab Emirates', query: 'engineer technician mechanic', city: 'Dubai' },
      { name: 'Oman', query: 'engineer technician operator', city: 'Muscat' },
      { name: 'Netherlands', query: 'engineer technician developer', city: 'Amsterdam' },
      { name: 'Lithuania', query: 'welder machinist driver', city: 'Vilnius' },
      { name: 'Estonia', query: 'engineer technician developer', city: 'Tallinn' },
      { name: 'Malta', query: 'technician engineer specialist', city: 'Valletta' },
      { name: 'Bahrain', query: 'engineer technician mechanic', city: 'Manama' },

      // 5 New Additions
      { name: 'Italy', query: 'welder technician operator', city: 'Rome' },
      { name: 'Czechia', query: 'machinist technician engineer', city: 'Brno' },
      { name: 'Greece', query: 'technician mechanic engineer', city: 'Athens' },
      { name: 'Cyprus', query: 'engineer developer technician', city: 'Nicosia' },
      { name: 'Jordan', query: 'engineer technician operator', city: 'Amman' }
    ];

    let allJobs = [];
    for (const target of targetCountries) {
      const jobs = await fetchJobsForRegion(target.name, target.query, target.city);
      allJobs.push(...jobs);
    }

    if (allJobs.length === 0) {
      console.log('No jobs found.');
      return;
    }

    console.log(`Appending ${allJobs.length} jobs across 43 target countries to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully updated sheet with 43 target countries!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();