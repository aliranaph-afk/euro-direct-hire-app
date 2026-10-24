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
  console.log('Fetching live jobs from Sweden (JobTech Dev API)...');
  try {
    const response = await fetch('https://jobsearch.api.jobtechdev.se/search?q=english%20welder%20cnc&limit=10');
    const data = await response.json();
    
    const extractedRows = [];
    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || 'Swedish Direct Employer';
      // Filter out staffing/placement agencies
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;

      const title = hit.headline;
      const country = 'Sweden';
      const city = hit.workplace_address?.municipality || 'Sweden';
      const applyUrl = hit.webpage_url;
      
      const isSkilled = /cnc|welder|machinist|electrician|engineer/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([
        title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice
      ]);
    }
    return extractedRows;
  } catch (err) {
    console.error('Sweden fetch error:', err.message);
    return [];
  }
}

// 3. FETCH FROM BELGIUM (VDAB OPEN SERVICES)
async function fetchBelgiumJobs() {
  console.log('Fetching live jobs from Belgium (VDAB Public API)...');
  try {
    const response = await fetch('https://developer.vdab.be/openservices/vacatures/v1/vacatures?trefwoord=technician%20cnc%20welder&limit=10');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    const extractedRows = [];

    for (const job of data.vacatures || data.results || []) {
      const employer = job.werkgever?.naam || job.companyName || 'Belgian Direct Employer';
      if (/interim|staffing|manpower|adecco|randstad/i.test(employer)) continue;

      const title = job.titel || job.title;
      const country = 'Belgium';
      const city = job.locatie?.gemeente || 'Flanders';
      const applyUrl = job.links?.solliciteerUrl || job.url || 'https://www.vdab.be/vindicat/vacatures';

      const isSkilled = /cnc|welder|machinist|technician|electrician|engineer/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([
        title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice
      ]);
    }
    return extractedRows;
  } catch (err) {
    console.log('Belgium (VDAB) skipped (endpoint offline or key pending).');
    return [];
  }
}

// 4. FETCH FROM FRANCE (FRANCE TRAVAIL / PÔLE EMPLOI)
async function fetchFranceJobs() {
  console.log('Fetching live jobs from France (France Travail Open Data)...');
  try {
    const response = await fetch('https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search?motsCles=soudure%20usinage%20maintenance&range=0-9', {
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const extractedRows = [];

    for (const item of data.resultats || []) {
      const employer = item.entreprise?.nom || 'French Employer';
      if (/interim|adecco|manpower|randstad|crit/i.test(employer)) continue;

      const title = item.intitule;
      const country = 'France';
      const city = item.lieuTravail?.libelle || 'France';
      const applyUrl = item.origineOffre?.url || 'https://candidat.francetravail.fr';

      const isSkilled = /soud|usinag|technicien|mecanicien|ingenieur/i.test(title);
      const priorityTier = isSkilled ? 'Priority 2' : 'Priority 1';
      const dmwNotice = isSkilled ? 'MWO Direct-Hire Exemption (Max 5)' : 'Requires DMW-Accredited PRA';

      extractedRows.push([
        title, country, city, employer, priorityTier, applyUrl, 'S1', dmwNotice
      ]);
    }
    return extractedRows;
  } catch (err) {
    console.log('France Travail skipped (OAuth client credentials pending).');
    return [];
  }
}

// 5. MAIN EXECUTOR & GOOGLE SHEETS UPLOADER
async function runIngestionPipeline() {
  try {
    const swedenJobs = await fetchSwedenJobs();
    const belgiumJobs = await fetchBelgiumJobs();
    const franceJobs = await fetchFranceJobs();
    
    const allExtractedJobs = [...swedenJobs, ...belgiumJobs, ...franceJobs];

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
      requestBody: {
        values: allExtractedJobs,
      },
    });

    console.log('Successfully updated database!');
  } catch (error) {
    console.error('Error during ingestion pipeline:', error.message);
  }
}

runIngestionPipeline();