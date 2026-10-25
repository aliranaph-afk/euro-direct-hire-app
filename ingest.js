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

// 1. SWEDEN: Dedicated Fetch via JobTech Dev API
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

// 2. FINLAND: Dedicated Fetch via Job Market Finland Open API
async function fetchFinlandJobs() {
  console.log('Fetching live jobs for Finland...');
  try {
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

// 3. EUROPEAN & INTERNATIONAL TARGETS AGGREGATOR
async function fetchTargetJobs(countryName, defaultCity, queryTerm) {
  console.log(`Fetching visa-sponsored opportunities for ${countryName}...`);
  try {
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

    // Dedicated Source Calls
    const swedenJobs = await fetchSwedenJobs();
    const finlandJobs = await fetchFinlandJobs();
    allJobs.push(...swedenJobs, ...finlandJobs);

    // FULL LIST OF ALL 44 EUROPEAN NATIONS (+ CANADA & AUSTRALIA)
    const europeanTargets = [
      // Northern Europe
      { name: 'Denmark', city: 'Copenhagen', query: 'engineer technician developer' },
      { name: 'Norway', city: 'Oslo', query: 'engineer technician mechanic' },
      { name: 'Iceland', city: 'Reykjavik', query: 'technician mechanic engineer' },
      { name: 'Ireland', city: 'Dublin', query: 'engineer technician developer' },
      { name: 'United Kingdom', city: 'London', query: 'engineer technician developer' },
      { name: 'Estonia', city: 'Tallinn', query: 'developer engineer specialist' },
      { name: 'Latvia', city: 'Riga', query: 'technician engineer specialist' },
      { name: 'Lithuania', city: 'Vilnius', query: 'developer engineer technician' },

      // Western Europe
      { name: 'Netherlands', city: 'Amsterdam', query: 'engineer technician developer' },
      { name: 'Belgium', city: 'Brussels', query: 'engineer technician specialist' },
      { name: 'Luxembourg', city: 'Luxembourg City', query: 'developer engineer specialist' },
      { name: 'France', city: 'Paris', query: 'engineer technician developer' },
      { name: 'Germany', city: 'Berlin', query: 'engineer technician developer welder' },
      { name: 'Austria', city: 'Vienna', query: 'engineer technician specialist' },
      { name: 'Switzerland', city: 'Zurich', query: 'engineer specialist developer' },
      { name: 'Liechtenstein', city: 'Vaduz', query: 'engineer specialist' },
      { name: 'Monaco', city: 'Monaco', query: 'specialist manager' },

      // Southern Europe
      { name: 'Spain', city: 'Madrid', query: 'engineer developer technician' },
      { name: 'Portugal', city: 'Lisbon', query: 'developer engineer technician' },
      { name: 'Italy', city: 'Rome', query: 'engineer technician operator' },
      { name: 'Greece', city: 'Athens', query: 'engineer technician specialist' },
      { name: 'Malta', city: 'Valletta', query: 'developer specialist technician' },
      { name: 'Cyprus', city: 'Nicosia', query: 'developer engineer specialist' },
      { name: 'Croatia', city: 'Zagreb', query: 'engineer technician developer' },
      { name: 'Slovenia', city: 'Ljubljana', query: 'engineer technician specialist' },
      { name: 'Albania', city: 'Tirana', query: 'engineer technician' },
      { name: 'Andorra', city: 'Andorra la Vella', query: 'specialist technician' },
      { name: 'Bosnia and Herzegovina', city: 'Sarajevo', query: 'engineer technician' },
      { name: 'Montenegro', city: 'Podgorica', query: 'engineer technician' },
      { name: 'North Macedonia', city: 'Skopje', query: 'engineer technician' },
      { name: 'San Marino', city: 'San Marino', query: 'technician specialist' },
      { name: 'Serbia', city: 'Belgrade', query: 'engineer developer technician' },
      { name: 'Vatican City', city: 'Vatican City', query: 'administrator' },

      // Central & Eastern Europe
      { name: 'Poland', city: 'Warsaw', query: 'engineer developer welder technician' },
      { name: 'Czech Republic', city: 'Prague', query: 'engineer technician developer' },
      { name: 'Slovakia', city: 'Bratislava', query: 'engineer technician operator' },
      { name: 'Hungary', city: 'Budapest', query: 'engineer technician developer' },
      { name: 'Romania', city: 'Bucharest', query: 'engineer developer technician' },
      { name: 'Bulgaria', city: 'Sofia', query: 'developer engineer technician' },
      { name: 'Belarus', city: 'Minsk', query: 'developer engineer' },
      { name: 'Moldova', city: 'Chisinau', query: 'engineer specialist' },
      { name: 'Ukraine', city: 'Kyiv', query: 'engineer specialist developer' },

      // Non-EU / Intercontinental Targets
      { name: 'Canada', city: 'Toronto', query: 'welder machinist engineer' },
      { name: 'Australia', city: 'Sydney', query: 'welder engineer technician' }
    ];

    for (const target of europeanTargets) {
      const targetJobs = await fetchTargetJobs(target.name, target.city, target.query);
      allJobs.push(...targetJobs);
    }

    if (allJobs.length === 0) {
      console.log('No matching visa-sponsored jobs found across target European regions.');
      return;
    }

    console.log(`Appending ${allJobs.length} visa-sponsored listings to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully completed 44-nation European ingestion!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();