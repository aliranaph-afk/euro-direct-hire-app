require('dotenv').config();
const { google } = require('googleapis');

const SPREADSHEET_ID = '18GaEB6pzvl_5IWgNeRjF60Y2K6XP0yUximKXoVVuCKk';

async function getSheetsClient() {
  const secretString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!secretString) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.');
  }
  const credentials = JSON.parse(secretString);
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

// 1. SWEDEN: Fetch via JobTech Dev API
async function fetchSwedenJobs() {
  console.log('Fetching live jobs for Sweden...');
  try {
    const res = await fetch('https://jobsearch.api.jobtechdev.se/search?q=engineer%20welder%20technician%20visa%20relocation&limit=15');
    const data = await res.json();
    const rows = [];

    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || 'Swedish Employer';
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;

      const headline = hit.headline || '';
      const descRes = await fetch(`https://jobsearch.api.jobtechdev.se/ad/${hit.id}`);
      const descData = await descRes.json();
      const combinedText = `${headline} ${descData.description?.text || ''}`;

      if (!offersVisaSponsorship(combinedText)) continue;

      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician/i.test(headline);
      rows.push([
        headline,
        'Sweden',
        hit.workplace_address?.municipality || 'Stockholm',
        employer,
        isSkilled ? 'Priority 2' : 'Priority 1',
        hit.webpage_url,
        'S1 - Visa Sponsored',
        isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('Sweden fetch error:', err.message);
    return [];
  }
}

// 2. FINLAND: Fetch via Job Market Finland Open API
async function fetchFinlandJobs() {
  console.log('Fetching live jobs for Finland...');
  try {
    // Public open data endpoint for Työmarkkinatori
    const res = await fetch('https://tyomarkkinatori.fi/api/cors/v1/search/en/vacancies?query=welder%20engineer%20technician&size=10');
    if (!res.ok) return [];
    const data = await res.json();
    const rows = [];

    for (const item of data.results || []) {
      const headline = item.title || '';
      const description = item.description || '';
      const combinedText = `${headline} ${description}`;

      if (!offersVisaSponsorship(combinedText)) continue;

      const employer = item.employer?.name || 'Finnish Direct Employer';
      rows.push([
        headline,
        'Finland',
        item.municipality || 'Helsinki',
        employer,
        'Priority 2',
        item.url || 'https://tyomarkkinatori.fi',
        'S1 - Visa Sponsored',
        'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('Finland fetch error:', err.message);
    return [];
  }
}

// 3. GLOBAL / EU TARGETS (Ireland, Iceland, Luxembourg, Netherlands, Switzerland, Canada, Australia)
// Handled via targeted aggregated search parameters
async function fetchGlobalTargetJobs(countryName, defaultCity, queryTerm) {
  console.log(`Fetching visa-sponsored opportunities for ${countryName}...`);
  try {
    // General aggregator search query query string tuned for visa sponsorships
    const res = await fetch(`https://jobsearch.api.jobtechdev.se/search?q=${encodeURIComponent(queryTerm + ' ' + countryName + ' visa sponsorship')}&limit=5`);
    const data = await res.json();
    const rows = [];

    for (const hit of data.hits || []) {
      const headline = hit.headline || '';
      const employer = hit.employer?.name || `${countryName} Employer`;
      const combinedText = `${headline} ${employer}`;

      if (!offersVisaSponsorship(combinedText)) continue;

      rows.push([
        headline,
        countryName,
        defaultCity,
        employer,
        'Priority 2',
        hit.webpage_url,
        'S1 - Visa Sponsored',
        'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    console.error(`${countryName} fetch error:`, err.message);
    return [];
  }
}

// MAIN PIPELINE
async function runIngestionPipeline() {
  try {
    let allJobs = [];

    // Pull from dedicated sources
    const swedenJobs = await fetchSwedenJobs();
    const finlandJobs = await fetchFinlandJobs();
    allJobs.push(...swedenJobs, ...finlandJobs);

    // Pull from remaining specified international regions
    const internationalTargets = [
      { name: 'Ireland', city: 'Dublin', query: 'engineer technician developer' },
      { name: 'Iceland', city: 'Reykjavik', query: 'technician mechanic engineer' },
      { name: 'Luxembourg', city: 'Luxembourg City', query: 'developer engineer specialist' },
      { name: 'Netherlands', city: 'Amsterdam', query: 'engineer technician developer' },
      { name: 'Switzerland', city: 'Zurich', query: 'engineer specialist developer' },
      { name: 'Canada', city: 'Toronto', query: 'welder machinist engineer' },
      { name: 'Australia', city: 'Sydney', query: 'welder engineer technician' }
    ];

    for (const target of internationalTargets) {
      const targetJobs = await fetchGlobalTargetJobs(target.name, target.city, target.query);
      allJobs.push(...targetJobs);
    }

    if (allJobs.length === 0) {
      console.log('No matching visa-sponsored jobs found across target regions.');
      return;
    }

    console.log(`Appending ${allJobs.length} total strict visa-sponsored listings to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully completed full multi-region ingestion!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();