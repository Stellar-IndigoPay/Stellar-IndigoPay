const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

function buildMerkleTree(entries) {
  // entries: [{ id, prevHash, action, actor, resource, timestamp }]
  const leaves = entries.map(entry =>
    sha256(
      `${entry.id}${entry.prevHash}${entry.action}${entry.actor}${entry.resource}${entry.timestamp}`
    )
  );
  let level = leaves;
  const tree = [leaves];
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const pair = [level[i], level[i + 1]].sort(Buffer.compare);
        nextLevel.push(sha256(Buffer.concat(pair)));
      } else {
        nextLevel.push(level[i]);
      }
    }
    level = nextLevel;
    tree.push(level);
  }
  return { root: level[0], tree };
}

function generateMerkleProof(tree, leafIndex) {
  const leaves = tree[0];
  if (leafIndex >= leaves.length) throw new Error('Leaf index out of bounds');
  const proof = [];
  let index = leafIndex;
  for (let levelIdx = 0; levelIdx < tree.length - 1; levelIdx++) {
    const level = tree[levelIdx];
    const isRight = index % 2 === 0;
    const siblingIdx = isRight ? index + 1 : index - 1;
    if (siblingIdx >= 0 && siblingIdx < level.length) {
      proof.push({
        position: isRight ? 'right' : 'left',
        hash: level[siblingIdx]
      });
    }
    index = Math.floor(index / 2);
  }
  return proof;
}

function verifyMerkleProof(leaf, proof, root) {
  let hash = leaf;
  for (const step of proof) {
    const pair = step.position === 'right' ? [hash, step.hash] : [step.hash, hash];
    hash = sha256(Buffer.concat(pair.sort(Buffer.compare)));
  }
  return hash.equals(root);
}

module.exports = { buildMerkleTree, generateMerkleProof, verifyMerkleProof };
