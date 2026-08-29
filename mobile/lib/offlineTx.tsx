import React from 'react';
import { TransactionBuilder, Account, Networks, Operation, Memo, Asset } from '@stellar/stellar-sdk';
import { cache } from './offlineCache';
import { enqueueItem } from './offlineQueue';
import { sign, getPublicKey } from './stellarSigner';
import QRCode from 'react-native-qrcode-svg';

export interface OfflineTxParams {
  alias: string;
  destination: string;
  amount: string;
  memo?: string;
  networkPassphrase?: string;
}

export async function buildAndSignOfflineTx(params: OfflineTxParams): Promise<string> {
  const { alias, destination, amount, memo, networkPassphrase = Networks.PUBLIC } = params;

  // 1. Get cached account sequence
  const sequenceResult = await cache.get<string>(`offline_sequence_${alias}`);
  const ledgerResult = await cache.get<number>('offline_ledger');

  if (!sequenceResult || !sequenceResult.data) {
    throw new Error('Offline sequence not found. Please connect to the internet first to cache data.');
  }

  const sourcePubkey = await getPublicKey(alias);
  if (!sourcePubkey) {
    throw new Error('Public key not found for alias');
  }

  // Account object requires current sequence number minus 1 to build transaction?
  // stellar-sdk Account object takes the exact current sequence number
  const account = new Account(sourcePubkey, sequenceResult.data);

  // 2. Build Transaction
  let builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + 86400 * 30, // 30 days valid
    },
  });

  builder.addOperation(
    Operation.payment({
      destination,
      asset: Asset.native(),
      amount,
    })
  );

  if (memo) {
    builder.addMemo(Memo.text(memo));
  }

  const transaction = builder.build();

  // 3. Sign the transaction using hardware-backed signer
  const signature = await sign(alias, transaction.hash(), `Sign ${amount} XLM to ${destination}`);
  transaction.addSignature(sourcePubkey, signature.toString('base64'));
  
  // 4. Update the cached sequence number for subsequent offline transactions
  // The transaction builder increments the sequence number internally, so we can just grab it
  const nextSequence = account.sequenceNumber();
  await cache.set(`offline_sequence_${alias}`, nextSequence);

  return transaction.toXDR();
}

export async function queueOfflineTx(xdr: string, alias: string) {
  await enqueueItem({
    type: 'submit_tx',
    payload: { xdr, alias },
    maxRetries: 5,
  });
}

// React component for QR Code
export function TxQRCode({ xdr, size = 200 }: { xdr: string; size?: number }) {
  // @ts-ignore
  return <QRCode value={xdr} size={size} />;
}
