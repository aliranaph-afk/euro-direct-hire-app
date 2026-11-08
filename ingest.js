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

// A keyword match is only a search filter, not confirmation of sponsorship.
function mentionsVisaOrRelocation(text) {
  if (!text) return false;
  const visaRegex = /visa|relocab|relocation|work\s*permit|sponsorship|permit|visa\s*support/i;
  return visaRegex.test(text);
}

function hasExplicitVisaSponsorship(text) {
  if (!text) return false;

  const negativeStatement =
    /\b(?:no|not|without|cannot|can't|doesn't|does not|do not|don't)\s+(?:offer|provide)?\s*(?:(?:visa|work)\s+)?sponsorship\b|\bvisa sponsorship\s+(?:is\s+)?(?:not available|not provided|not offered)\b|\b(?:aucun|aucune|pas de|sans)\s+(?:sponsoring|parrainage|prise en charge|visa sponsorship)\b|\b(?:ne proposons pas|ne fournissons pas|ne prenons pas en charge)\b.{0,80}\b(?:visa|permis|autorisation)\b/i;
  if (negativeStatement.test(text)) return false;

  const explicitSupport =
    /\bvisa sponsorship\b|\bwork permit sponsorship\b|\b(?:sponsor|sponsors|sponsored|sponsoring)\s+(?:the\s+|a\s+|your\s+)?(?:work\s+)?visa\b|\b(?:prise en charge|financement)\s+(?:de\s+la\s+|du\s+|des\s+démarches\s+de\s+|de\s+)?(?:visa|permis de travail|autorisation de travail)\b|\b(?:visa|permis de travail)\s+pris(?:e)?\s+en charge\b|\b(?:sponsoring|parrainage)\s+(?:de\s+)?(?:visa|permis de travail)\b|\b(?:employeur|l'employeur)\s+(?:prend|prendra|peut prendre)\s+en charge\b.{0,80}\b(?:visa|permis|autorisation)\b/i;
  return explicitSupport.test(text);
}

// 1. SWEDEN: Fetch from Sweden's Official JobTech Dev API
async function fetchSwedenJobs() {
  console.log('Fetching live jobs for Sweden...');
  try {
    const res = await fetch('https://jobsearch.api.jobtechdev.se/search?q=engineer%20welder%20technician%20relocation&limit=20');
    const data = await res.json();
    const rows = [];

    for (const hit of data.hits || []) {
      const employer = hit.employer?.name || 'Employer not provided';
      if (/bemanning|staffing|manpower|adecco|randstad/i.test(employer)) continue;

      const headline = hit.headline || '';
      const descRes = await fetch(`https://jobsearch.api.jobtechdev.se/ad/${hit.id}`);
      const descData = await descRes.json();
      const combinedText = `${headline} ${descData.description?.text || ''}`;

      if (!mentionsVisaOrRelocation(combinedText)) continue;

      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician/i.test(headline);
      rows.push([
        headline,
        'Sweden',
        hit.workplace_address?.municipality || 'Stockholm',
        employer,
        isSkilled ? 'Priority 2' : 'Priority 1',
        hit.webpage_url,
        'Potential visa/relocation keyword match - not verified',
        'Confirm sponsorship, work authorization, and Philippine deployment requirements independently'
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

      if (!mentionsVisaOrRelocation(combinedText)) continue;

      const employer = item.employer?.name || 'Employer not provided';
      rows.push([
        headline,
        'Finland',
        item.municipality || 'Helsinki',
        employer,
        'Priority 2',
        item.url || 'https://tyomarkkinatori.fi',
        'Potential visa/relocation keyword match - not verified',
        'Confirm sponsorship, work authorization, and Philippine deployment requirements independently'
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
  console.log('Fetching public European & international job listings...');
  try {
    const res = await fetch('https://jobicy.com/api/v2/remote-jobs?count=50&geo=europe');
    if (!res.ok) return [];
    const data = await res.json();
    const rows = [];

    for (const job of data.jobs || []) {
      const headline = job.jobTitle || '';
      const description = job.jobDescription || '';
      const combinedText = `${headline} ${description}`;

      // Include potential matches only; source text does not verify eligibility or sponsorship.
      if (!mentionsVisaOrRelocation(combinedText) && !/worldwide|anywhere|everywhere/i.test(job.jobGeo || '')) {
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
        'Potential visa/relocation keyword match - not verified',
        'Confirm sponsorship, work authorization, and Philippine deployment requirements independently'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('European feed fetch error:', err.message);
    return [];
  }
}

// 4. FRANCE: France Travail's partner job-offer API.
async function fetchFranceTravailJobs() {
  if (process.env.FRANCETRAVAIL_REUSE_AUTHORIZED !== 'true') {
    console.log('France Travail source skipped: confirm commercial reuse rights before enabling it.');
    return [];
  }

  const clientId = process.env.FRANCETRAVAIL_API_CLIENT_ID;
  const clientSecret = process.env.FRANCETRAVAIL_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('France Travail source requires FRANCETRAVAIL_API_CLIENT_ID and FRANCETRAVAIL_API_CLIENT_SECRET.');
  }

  console.log('Fetching sponsorship-related job offers from France Travail...');
  try {
    const tokenResponse = await fetch(
      'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'api_offresdemploiv2',
        }),
      }
    );
    if (!tokenResponse.ok) {
      throw new Error(`OAuth request failed (${tokenResponse.status}): ${(await tokenResponse.text()).slice(0, 300)}`);
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) throw new Error('France Travail OAuth response did not include an access token.');

    const searchTerms = [
      'visa sponsorship',
      'permis de travail',
      'autorisation de travail',
      'prise en charge visa',
      'sponsoring visa',
    ];
    const offersById = new Map();

    for (const term of searchTerms) {
      const url = new URL('https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search');
      url.searchParams.set('motsCles', term);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Range: '0-49',
        },
      });
      if (!response.ok) {
        throw new Error(`France Travail search failed for "${term}" (${response.status}): ${(await response.text()).slice(0, 300)}`);
      }

      const data = await response.json();
      const offers = Array.isArray(data) ? data : data.resultats;
      if (!Array.isArray(offers)) throw new Error('France Travail response did not contain a job-offer list.');
      for (const offer of offers) {
        if (offer.id) offersById.set(String(offer.id), offer);
      }
    }

    const rows = [];
    for (const offer of offersById.values()) {
      const headline = offer.intitule || '';
      const description = offer.description || '';
      if (!hasExplicitVisaSponsorship(`${headline}\n${description}`)) continue;

      const employer = offer.entreprise?.nom || 'Employer not provided';
      const isSkilled = /cnc|welder|engineer|machinist|technician|developer|mechanic|operator|electrician/i.test(headline);
      rows.push([
        headline,
        'France',
        offer.lieuTravail?.libelle || 'Location not provided',
        employer,
        isSkilled ? 'Priority 2' : 'Priority 1',
        offer.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/recherche/detail/${encodeURIComponent(offer.id)}`,
        'Potential explicit visa/work-permit support statement - not verified',
        'Confirm the employer will hire applicants from the Philippines, provide work authorisation support, and meet Philippine deployment requirements'
      ]);
    }
    return rows;
  } catch (err) {
    console.error('France Travail fetch error:', err.message);
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

    // 4. Fetch French job offers when API access and reuse rights are configured
    const franceJobs = await fetchFranceTravailJobs();
    allJobs.push(...franceJobs);

    if (allJobs.length === 0) {
      console.log('No matching public job listings found.');
      return;
    }

    console.log(`Appending ${allJobs.length} public job listings to Google Sheet...`);
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Job_Listings!A:H',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: allJobs },
    });
    console.log('Successfully appended multi-source job listings to sheet!');
  } catch (error) {
    console.error('Pipeline error:', error.message);
  }
}

if (require.main === module) runIngestionPipeline();

module.exports = { fetchFranceTravailJobs, hasExplicitVisaSponsorship };