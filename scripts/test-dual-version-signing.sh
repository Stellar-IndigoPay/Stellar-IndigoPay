#!/bin/bash
# Test script for dual-version webhook signing and verification

set -e

echo "🔐 Testing Dual-Version Webhook Signing and Verification"
echo "=========================================================="

# Run tests from the project root
cd /home/devmaro/Stellar-IndigoPay

# Test 1: Basic dual-version signing
echo "Test 1: Basic dual-version signing with current and previous secrets"
cat > test_sign.js << 'EOF'
const { sign, verify, generateKeyId } = require('./backend/src/lib/webhookSign');

const body = '{"test":"data"}';
const currentSecret = 'current_secret_123';
const previousSecret = 'previous_secret_456';
const timestamp = Math.floor(Date.now() / 1000);
const keyId = 'v1-2024-01-15';

const signature = sign(body, currentSecret, timestamp, previousSecret, keyId);
console.log('Generated signature:', signature);

// Verify the signature contains both v1 and v2
if (signature.includes('v1=') && signature.includes('v2=')) {
  console.log('✅ Dual-version signature contains both v1 and v2');
} else {
  console.log('❌ Dual-version signature missing v1 or v2');
  process.exit(1);
}

// Verify the key ID is present
if (signature.includes('kid=')) {
  console.log('✅ Key ID present in signature');
} else {
  console.log('❌ Key ID missing from signature');
  process.exit(1);
}

// Test verification with current secret
const secrets = [currentSecret, previousSecret];
const isValid = verify(body, secrets, signature);
if (isValid) {
  console.log('✅ Signature verification passed with current secret');
} else {
  console.log('❌ Signature verification failed with current secret');
  process.exit(1);
}

// Test verification with only previous secret (simulating receiver update)
const oldSecrets = [previousSecret];
const isValidWithOld = verify(body, oldSecrets, signature);
if (isValidWithOld) {
  console.log('✅ Signature verification passed with previous secret only');
} else {
  console.log('❌ Signature verification failed with previous secret only');
  process.exit(1);
}

console.log('✅ All dual-version signing tests passed');
EOF

node test_sign.js

# Test 2: Key ID generation and parsing
echo ""
echo "Test 2: Key ID generation and parsing"
cat > test_keyid.js << 'EOF'
const { generateKeyId, parseKeyId, isKeyExpired, GRACE_PERIOD_DAYS } = require('./backend/src/lib/webhookSign');

const keyId = generateKeyId(1, new Date('2024-01-15'));
console.log('Generated key ID:', keyId);

const parsed = parseKeyId(keyId);
if (parsed && parsed.version === 1 && parsed.date === '2024-01-15') {
  console.log('✅ Key ID parsing works correctly');
} else {
  console.log('❌ Key ID parsing failed');
  process.exit(1);
}

// Test expiry check
const oldDate = new Date('2020-01-01');
const oldKeyId = generateKeyId(1, oldDate);
if (isKeyExpired(oldKeyId)) {
  console.log('✅ Old key is correctly identified as expired');
} else {
  console.log('❌ Old key expiry check failed');
  process.exit(1);
}

const recentKeyId = generateKeyId(1, new Date());
if (!isKeyExpired(recentKeyId)) {
  console.log('✅ Recent key is correctly identified as not expired');
} else {
  console.log('❌ Recent key expiry check failed');
  process.exit(1);
}

console.log('✅ All key ID tests passed');
EOF

node test_keyid.js

# Test 3: Multi-version verification
echo ""
echo "Test 3: Multi-version verification with 3-version window"
cat > test_multiversion.js << 'EOF'
const { sign, verify } = require('./backend/src/lib/webhookSign');

const body = '{"test":"data"}';
const currentSecret = 'current_secret_123';
const previousSecret = 'previous_secret_456';
const nextSecret = 'next_secret_789';
const timestamp = Math.floor(Date.now() / 1000);

// Sign with current and previous
const signature = sign(body, currentSecret, timestamp, previousSecret, 'v1-2024-01-15');

// Test 3-version window verification
const threeVersionSecrets = [currentSecret, previousSecret, nextSecret];
const isValid = verify(body, threeVersionSecrets, signature);
if (isValid) {
  console.log('✅ 3-version window verification works');
} else {
  console.log('❌ 3-version window verification failed');
  process.exit(1);
}

// Test with wrong secret only
const wrongSecrets = ['wrong_secret'];
const isInvalid = !verify(body, wrongSecrets, signature);
if (isInvalid) {
  console.log('✅ Verification correctly rejects wrong secrets');
} else {
  console.log('❌ Verification should reject wrong secrets');
  process.exit(1);
}

console.log('✅ All multi-version verification tests passed');
EOF

node test_multiversion.js

# Test 4: Webhook verifier utility
echo ""
echo "Test 4: Webhook verifier utility functions"
cat > test_verifier.js << 'EOF'
const { verifyWebhookSignature, extractKeyId, extractTimestamp, parseSignatureHeader } = require('./backend/src/lib/webhookVerifier');

const body = '{"test":"data"}';
const currentSecret = 'current_secret_123';
const previousSecret = 'previous_secret_456';
const timestamp = Math.floor(Date.now() / 1000);
const keyId = 'v1-2024-01-15';

const { sign } = require('./backend/src/lib/webhookSign');
const signature = sign(body, currentSecret, timestamp, previousSecret, keyId);

// Test key ID extraction
const extractedKeyId = extractKeyId(signature);
if (extractedKeyId === keyId) {
  console.log('✅ Key ID extraction works');
} else {
  console.log('❌ Key ID extraction failed');
  process.exit(1);
}

// Test timestamp extraction
const extractedTimestamp = extractTimestamp(signature);
if (extractedTimestamp === timestamp) {
  console.log('✅ Timestamp extraction works');
} else {
  console.log('❌ Timestamp extraction failed');
  process.exit(1);
}

// Test signature header parsing
const parsed = parseSignatureHeader(signature);
if (parsed.timestamp === timestamp && parsed.keyId === keyId && parsed.signatures.length > 0) {
  console.log('✅ Signature header parsing works');
} else {
  console.log('❌ Signature header parsing failed');
  process.exit(1);
}

// Test webhook signature verification
const secrets = [currentSecret, previousSecret];
const isValid = verifyWebhookSignature(body, signature, secrets);
if (isValid) {
  console.log('✅ Webhook signature verification works');
} else {
  console.log('❌ Webhook signature verification failed');
  process.exit(1);
}

console.log('✅ All webhook verifier tests passed');
EOF

node test_verifier.js

# Test 5: Integration with signingSecretProvider
echo ""
echo "Test 5: Integration with signingSecretProvider"
cat > test_provider.js << 'EOF'
const { getMultiVersionSigningSecrets } = require('./backend/src/services/signingSecretProvider');

// Test with environment variable fallback
process.env.WEBHOOK_SIGNING_SECRET = 'test_secret';
process.env.NODE_ENV = 'test';

getMultiVersionSigningSecrets()
  .then(secrets => {
    if (secrets.current === 'test_secret') {
      console.log('✅ Fallback to environment variable works');
    } else {
      console.log('❌ Fallback to environment variable failed');
      process.exit(1);
    }

    if (secrets.keyId) {
      console.log('✅ Key ID is present');
    } else {
      console.log('❌ Key ID is missing');
      process.exit(1);
    }

    console.log('✅ All signingSecretProvider tests passed');
  })
  .catch(err => {
    console.log('❌ signingSecretProvider test failed:', err.message);
    process.exit(1);
  });
EOF

node test_provider.js

# Cleanup test files
rm -f test_sign.js test_keyid.js test_multiversion.js test_verifier.js test_provider.js

echo ""
echo "=========================================================="
echo "✅ All dual-version signing and verification tests passed!"
echo "=========================================================="