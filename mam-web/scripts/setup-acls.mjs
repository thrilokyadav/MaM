const NUXEO_URL = 'http://127.0.0.1:8081/nuxeo/api/v1';
const AUTH_HEADER = 'Basic ' + Buffer.from('Administrator:Administrator').toString('base64');

async function grantACE(group, permission) {
  const url = `${NUXEO_URL}/path/default-domain/workspaces/@op/Document.SetACE`;
  const body = {
    params: {
      user: group,
      permission: permission,
      grant: true
    }
  };

  console.log(`Granting ${permission} to ${group} on /default-domain/workspaces...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    console.log(`✓ Granted ${permission} to ${group}`);
  } else {
    const text = await res.text();
    console.error(`✗ Failed for ${group}: ${res.status} ${text}`);
  }
}

async function main() {
  await grantACE('mam-producers', 'MAM_ProducerAccess');
  await grantACE('mam-producers', 'Write');
  await grantACE('mam-editors', 'MAM_EditorAccess');
  await grantACE('mam-editors', 'Read');
  await grantACE('mam-archivists', 'MAM_ArchivistAccess');
  await grantACE('mam-archivists', 'Write');
  await grantACE('mam-publishers', 'MAM_PublisherAccess');
  await grantACE('mam-publishers', 'Read');
  await grantACE('members', 'Read');
  console.log('All permissions updated successfully!');
}

main().catch(err => console.error(err));
