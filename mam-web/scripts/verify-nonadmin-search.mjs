const NUXEO_URL = 'http://127.0.0.1:8081/nuxeo/api/v1';

async function main() {
  const adminAuth = 'Basic ' + Buffer.from('Administrator:Administrator').toString('base64');
  
  // 1. Create test_producer user if not exists
  console.log('Creating test_producer user...');
  await fetch(`${NUXEO_URL}/user`, {
    method: 'POST',
    headers: {
      'Authorization': adminAuth,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      'entity-type': 'user',
      properties: {
        username: 'test_producer',
        password: 'Prod!2026',
        groups: ['mam-producers', 'members']
      }
    })
  });

  // 2. Perform search as test_producer
  const producerAuth = 'Basic ' + Buffer.from('test_producer:Prod!2026').toString('base64');
  console.log('Searching assets as test_producer for q=EasyWay...');
  const res = await fetch(`${NUXEO_URL}/search/pp/MAM_BROADCAST_ASSET_SEARCH/execute?q=%25EasyWay%25`, {
    method: 'GET',
    headers: {
      'Authorization': producerAuth,
      'properties': 'broadcast,dublincore,video'
    }
  });

  if (!res.ok) {
    console.error('Search failed:', res.status, await res.text());
    return;
  }

  const data = await res.json();
  console.log(`Found ${data.entries.length} documents for test_producer:`);
  data.entries.forEach(doc => {
    console.log(` - Title: ${doc.title || doc.properties['dc:title']}, Path: ${doc.path}, Status: ${doc.properties['broadcast:editorialStatus'] || 'none'}`);
  });
}

main().catch(err => console.error(err));
