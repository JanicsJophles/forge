#!/usr/bin/env python3
"""Archive every RAC issue currently in any 'completed' state."""
import json, urllib.request, concurrent.futures, sys

KEY = open('/root/.linear-key').read().strip()

def gql(query, variables=None):
    req = urllib.request.Request(
        'https://api.linear.app/graphql',
        data=json.dumps({'query': query, 'variables': variables or {}}).encode(),
        headers={'Authorization': KEY, 'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

# 1. List
data = gql('query{issues(filter:{team:{key:{eq:"RAC"}},state:{type:{eq:"completed"}}},first:250){nodes{id identifier}}}')
nodes = data['data']['issues']['nodes']
print(f'found {len(nodes)} Done', file=sys.stderr)

if not nodes:
    print(0)
    sys.exit(0)

# 2. Archive in parallel
def archive(node):
    try:
        r = gql('mutation A($id: String!){issueArchive(id:$id){success}}', {'id': node['id']})
        return r.get('data',{}).get('issueArchive',{}).get('success') is True
    except Exception:
        return False

with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    ok = sum(1 for r in ex.map(archive, nodes) if r)

print(ok)
