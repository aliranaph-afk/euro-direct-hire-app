const { google } = require('googleapis');

// 1. CONFIGURATION
const SPREADSHEET_ID = '18GaEB6pzvl_5IWgNeRjF60Y2K6XP0yUximKXoVVuCKk'; // Your Google Sheet ID
const SERVICE_ACCOUNT_FILE = './service_account.json';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// 2. FETCH FROM SWEDEN (JOBTECH DEV API)
async function fetchSwedenJobs() {
  console.log('Fetching live jobs from Sweden...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=english%20welder%20cnc&limit=10');
    const data = await response.json();
    
    const extractedRows = [];
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || 'Swedish Direct Employer';
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;

      const title = hit.headline;
      const country = 'Sweden';
      const city = hit.workplace_address?.municipality || 'Sweden';
      const applyUrl = hit.webpage_url;
      
      const isSkilled = /cnc|welder|machinist|electrician|engineer/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice]);
    }
    return extractedRows;
  } catch (err) {
    console.error('Sweden fetch error:', err.message);
    return [];
  }
}

// 3. FETCH FROM GERMANY (ARBEITSAGENTUR OPEN API)
async function fetchGermanyJobs() {
  console.log('Fetching live jobs from Germany...');
  try {
    // Public German Federal Employment Agency job search endpoint
    const response = await fetch('https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs?was=welder%20cnc%20engineer&pro=0&bezirk=0', {
      headers: { 'Accept': 'application/json', 'X-API-Key': 'jobboerse-jobsuche' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const extractedRows = [];

    for (const job of data.stellenangebote || []) {
      const employer = job.arbeitgeber || 'German Direct Employer';
      if (/zeitarbeit|personaldienstleistung|manpower|randstad/i.test(employer)) continue;

      const title = job.beruf;
      const country = 'Germany';
      const city = job.arbeitsort?.ort || 'Germany';
      const applyUrl = `https://www.arbeitsagentur.de/jobsuche/jobdetail/${job.refnr}`;

      const isSkilled = /cnc|welder|schweisser|mechaniker|ingenieur/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice]);
    }
    return extractedRows;
  } catch (err) {
    console.log('Germany fetch skipped or rate-limited, continuing...');
    return [];
  }
}

// 4. FETCH FROM NORWAY (NAV / ARBEIDSPLASSEN API)
async function fetchNorwayJobs() {
  console.log('Fetching live jobs from Norway...');
  try {
    // Norwegian Labour and Welfare Administration (NAV) public API
    const response = await fetch('https://arbeidsplassen.nav.no/public-api/stillinger?q=welder%20cnc%20engineer&size=10', {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const extractedRows = [];

    for (const job of data.content || data.hits || []) {
      const employer = job.businessName || job.employer?.name || 'Norwegian Direct Employer';
      if (/bemanning|bemanningsbyrå|adecco|manpower/i.test(employer)) continue;

      const title = job.title;
      const country = 'Norway';
      const city = job.municipal || 'Norway';
      const applyUrl = job.sourceurl || `https://arbeidsplassen.nav.no/stillinger/stilling/${job.id}`;

      const isSkilled = /cnc|sveiser|welder|engineer|tekniker/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice]);
    }
    return extractedRows;
  } catch (err) {
    console.log('Norway fetch skipped, continuing...');
    return [];
  }
}

// 5. MAIN EXECUTOR & GOOGLE SHEETS UPLOADER
async function runIngestionPipeline() {
  try {
    const swedenJobs = await fetchSwedenJobs();
    const germanyJobs = await fetchGermanyJobs();
    const norwayJobs = await fetchNorwayJobs();
    
    const allExtractedJobs = [...swedenJobs, ...germanyJobs, ...norwayJobs];

    if (allExtractedJobs.length === 0) {
      console.log('No new jobs extracted in this cycle.');
      return;
    }

    console.log(`Extracted ${allExtractedJobs.length} live verified jobs. Appending to Google Sheet...`);

    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allExtractedJobs },
    });

    console.log('Successfully updated database with multi-country listings!');
  } catch (error) {
    console.error('Error during ingestion pipeline:', error.message);
  }
}

runIngestionPipeline();