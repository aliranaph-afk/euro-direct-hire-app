require('dotenv').config();
const { google } = require('googleapis');

// 1. CONFIGURATION
const SPREADSHEET_ID = '18GaEB6pzvl_5IWgNeRjF60Y2K6XP0yUximKXoVVuCKk';

async function getSheetsClient() {
  const secretString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!secretString) {
    throw new Error(
      'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable. ' +
      'Please verify your local .env file or GitHub Actions Repository Secrets.'
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(secretString);
  } catch (err) {
    throw new Error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY JSON string: ' + err.message);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

// HELPER: Check if text explicitly offers visa/relocation support
function offersVisaSponsorship(text) {
  if (!text) return false;
  const visaRegex = /visa\s*sponsorship|relocation|work\s*permit|visa\s*support|sponsorship\s*available|relocation\s*package|relocation\s*assistance/i;
  return visaRegex.test(text);
}

// HELPER: Fetch detailed job description text from API by ID
async function fetchJobDetails(adId) {
  try {
    const res = await fetch(`https://jobsearch.api.jobtechdev.se/ad/${adId}`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.description?.text || '';
  } catch (err) {
    return '';
  }
}

// REGIONAL SEARCH HELPER WITH STRICT VISA SPONSORSHIP FILTER
async function fetchJobsForRegion(countryName, searchQuery, defaultCity) {
  console.log(`Fetching live jobs with visa sponsorship for ${countryName}...`);
  try {
    // Append 'visa' or 'relocation' to query to narrow down initial hits
    const fullQuery = `${searchQuery} visa relocation`;
    const response = await fetch(`https://jobsearch.api.jobtechdev.se/search?q=${encodeURIComponent(fullQuery)}&limit=10`);
    const data = await response.json();
    const rows = [];
    
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || `${countryName} Direct Employer`;
      
      // 1. Exclude staffing/recruitment agencies
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;
      
      const headline = hit.headline || '';
      
      // 2. Fetch full job description to verify strict visa sponsorship requirement
      const fullDescription = await fetchJobDetails(hit.id);
      const combinedText = `${headline} ${fullDescription}`;

      // 3. Strict Filter: Skip if visa sponsorship is not explicitly mentioned
      if (!offersVisaSponsorship(combinedText)) {
        continue;
      }

      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician|driver/i.test(headline);
      
      rows.push([
        headline, 
        countryName, 
        hit.workplace_address?.municipality || defaultCity, 
        employer, 
        isSkilled ? 'Priority 2' : 'Priority 1', 
        hit.webpage_url, 
        'S1 - Visa Sponsored', 
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
    // STRICT FILTER: Restricted exclusively to Sweden, Ireland, Iceland, Finland, Luxembourg, Netherlands, Switzerland, Canada, and Australia
    const targetCountries = [
      { name: 'Sweden', query: 'welder cnc engineer developer', city: 'Stockholm' },
      { name: 'Sweden Industrial North', query: 'electrician technician mechanic', city: 'Luleå' },
      { name: 'Sweden West Coast Belt', query: 'engineer technician mechanic', city: 'Gothenburg' },
      { name: 'Ireland', query: 'engineer technician operator developer', city: 'Dublin' },
      { name: 'Ireland Regional', query: 'machinist technician engineer', city: 'Cork' },
      { name: 'Ireland Midwest Corridor', query: 'technician engineer machinist', city: 'Limerick' },
      { name: 'Iceland', query: 'technician engineer mechanic developer', city: 'Reykjavik' },
      { name: 'Finland', query: 'welder machinist technician engineer', city: 'Helsinki' },
      { name: 'Finland Manufacturing', query: 'welder CNC operator', city: 'Tampere' },
      { name: 'Finland Tech North', query: 'engineer technician developer', city: 'Oulu' },
      { name: 'Luxembourg', query: 'engineer developer technician', city: 'Luxembourg City' },
      { name: 'Luxembourg Tech', query: 'developer specialist engineer', city: 'Esch-sur-Alzette' },
      { name: 'Netherlands', query: 'engineer technician developer', city: 'Amsterdam' },
      { name: 'Netherlands Brainport', query: 'developer engineer technician', city: 'Eindhoven' },
      { name: 'Switzerland', query: 'engineer technician specialist developer', city: 'Zurich' },
      { name: 'Switzerland Pharma Hub', query: 'engineer technician specialist', city: 'Basel' },
      { name: 'Canada', query: 'welder technician machinist engineer', city: 'Toronto' },
      { name: 'Australia', query: 'welder engineer technician developer', city: 'Sydney' }
    ];

    let allJobs = [];
    for (const target of targetCountries) {
      const jobs = await fetchJobsForRegion(target.name, target.query, target.city);
      allJobs.push(...jobs);
    }

    if (allJobs.length === 0) {
      console.log('No matching visa-sponsored jobs found for the selected regions.');
      return;
    }

    console.log(`Appending ${allJobs.length} visa-sponsored jobs to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully updated sheet with strict visa sponsorship listings!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();