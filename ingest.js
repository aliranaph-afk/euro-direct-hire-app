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

// HELPER: Flexible Visa / Relocation Checker
function offersVisaSponsorship(text) {
  if (!text) return false;
  const visaRegex = /visa|relocab|relocation|work\s*permit|sponsorship|permit|visa\s*support/i;
  return visaRegex.test(text);
}

// 1. SWEDEN: Fetch from Sweden's Official JobTech Dev API
async function fetchSwedenJobs() {
  console.log('Fetching live jobs for Sweden...');
  try {
    const res = await fetch('https://jobsearch.api.jobtechdev.se/search?q=engineer%20welder%20technician%20relocation&limit=20');
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

// 2. FINLAND: Fetch from Job Market Finland Open API
async function fetchFinlandJobs() {
  console.log('Fetching live jobs for Finland...');
  try {
    const res = await fetch('https://tyomarkkinatori.fi/api/cors/v1/search/en/vacancies?query=engineer%20technician%20welder&size=15');
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

// 3. EUROPE & INTERNATIONAL: Global Public Jobicy API Endpoint
async function fetchEuropeanJobs() {
  console.log('Fetching live European & International visa-sponsored listings...');
  try {
    const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=europe');
    if (!res.ok) return [];
    const data = await res.json();
    const rows = [];

    for (const job of data.jobs || []) {
      const headline = job.jobTitle || '';
      const description = job.jobDescription || '';
      const combinedText = `${headline} ${description}`;

      // Check for visa/relocation or international applicant allowance
      if (!offersVisaSponsorship(combinedText) && !/worldwide|anywhere|everywhere/i.test(job.jobGeo || '')) {
        continue;
      }

      const employer = job.companyName || 'European Employer';
      const location = job.jobGeo || 'Europe';

      rows.push([
        headline,
        location,
        'Remote / On-site',
        employer,
        'Priority 2',
        job.url,
        'S1 - Visa Sponsored',
        'MWO Direct-Hire Exemption (Max 5)'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('European feed fetch error:', err.message);
    return [];
  }
}

// MAIN INGESTION PIPELINE
async function runIngestionPipeline() {
  try {
    let allJobs = [];

    // 1. Fetch Swedish jobs
    const swedenJobs = await fetchSwedenJobs();
    allJobs.push(...swedenJobs);

    // 2. Fetch Finnish jobs
    const finlandJobs = await fetchFinlandJobs();
    allJobs.push(...finlandJobs);

    // 3. Fetch European / International jobs
    const euroJobs = await fetchEuropeanJobs();
    allJobs.push(...euroJobs);

    if (allJobs.length === 0) {
      console.log('No matching visa-sponsored jobs found.');
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
    console.log('Successfully appended multi-source visa-sponsored jobs to sheet!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

runIngestionPipeline();