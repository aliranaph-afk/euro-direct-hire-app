const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchFranceTravailJobs, hasExplicitVisaSponsorship } = require('../ingest');

test('requires explicit visa or work-permit sponsorship language', () => {
  assert.equal(hasExplicitVisaSponsorship('We offer visa sponsorship for this role.'), true);
  assert.equal(hasExplicitVisaSponsorship('The employer will sponsor your work visa.'), true);
  assert.equal(hasExplicitVisaSponsorship('Prise en charge des démarches de visa.'), true);
  assert.equal(hasExplicitVisaSponsorship('Permis de travail pris en charge.'), true);
});

test('does not treat general visa, permit, or relocation mentions as sponsorship', () => {
  assert.equal(hasExplicitVisaSponsorship('Applicants must have a valid work permit.'), false);
  assert.equal(hasExplicitVisaSponsorship('Relocation assistance may be available.'), false);
  assert.equal(hasExplicitVisaSponsorship('Visa requirements apply.'), false);
});

test('excludes postings that explicitly say sponsorship is unavailable', () => {
  assert.equal(hasExplicitVisaSponsorship('We do not offer visa sponsorship.'), false);
  assert.equal(hasExplicitVisaSponsorship('Visa sponsorship is not available.'), false);
  assert.equal(hasExplicitVisaSponsorship('Aucune prise en charge du visa.'), false);
});

test('maps only explicit sponsorship matches from France Travail API results', async () => {
  const originalFetch = global.fetch;
  const originalEnv = {
    authorized: process.env.FRANCETRAVAIL_REUSE_AUTHORIZED,
    clientId: process.env.FRANCETRAVAIL_API_CLIENT_ID,
    clientSecret: process.env.FRANCETRAVAIL_API_CLIENT_SECRET,
  };
  const requestedUrls = [];

  process.env.FRANCETRAVAIL_REUSE_AUTHORIZED = 'true';
  process.env.FRANCETRAVAIL_API_CLIENT_ID = 'test-client';
  process.env.FRANCETRAVAIL_API_CLIENT_SECRET = 'test-secret';
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    requestedUrls.push({ url, options });

    if (url.includes('access_token')) {
      return { ok: true, json: async () => ({ access_token: 'test-token' }) };
    }

    return {
      ok: true,
      json: async () => ({
        resultats: [
          {
            id: 'sponsored-job',
            intitule: 'Welder',
            description: 'The employer offers visa sponsorship.',
            entreprise: { nom: 'Example Employer' },
            lieuTravail: { libelle: 'Paris' },
            origineOffre: { urlOrigine: 'https://example.test/jobs/1' },
          },
          {
            id: 'generic-job',
            intitule: 'Technician',
            description: 'Applicants must have a valid work permit.',
            entreprise: { nom: 'Another Employer' },
            lieuTravail: { libelle: 'Lyon' },
          },
        ],
      }),
    };
  };

  try {
    const rows = await fetchFranceTravailJobs();
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], 'Welder');
    assert.equal(rows[0][1], 'France');
    assert.equal(rows[0][2], 'Paris');
    assert.equal(rows[0][5], 'https://example.test/jobs/1');
    assert.match(rows[0][6], /not verified/);
    assert.equal(requestedUrls.length, 6);
    assert.equal(requestedUrls[1].options.headers.Authorization, 'Bearer test-token');
    assert.equal(requestedUrls[1].options.headers.Range, '0-49');
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      FRANCETRAVAIL_REUSE_AUTHORIZED: originalEnv.authorized,
      FRANCETRAVAIL_API_CLIENT_ID: originalEnv.clientId,
      FRANCETRAVAIL_API_CLIENT_SECRET: originalEnv.clientSecret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
