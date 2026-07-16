/**
 * app/wallet/sep0007.tsx
 *
 * SEP-0007 web+stellar URI handler — parse, confirm, sign, submit.
 * Triggered by deep links from external dApps requesting transaction signing.
 */
import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { useBiometricAuth } from "../../hooks/useBiometricAuth";
import { loadSecretKey, signTransaction, submitTransaction } from "../../lib/wallet/sdk";
import { Networks, TransactionBuilder, Operation, Asset } from "@stellar/stellar-sdk";

const HORIZON_URL =
  process.env.EXPO_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";

interface ParsedOp {
  type: "payment";
  destination: string;
  amount: string;
  memo?: string;
}

export default function Sep0007Screen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { uri } = useLocalSearchParams<{ uri: string }>();
  const { session, isAuthenticated } = useAuth();
  const bio = useBiometricAuth();

  const [parsed, setParsed] = useState<ParsedOp | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const publicKey = session?.publicKey;

  useEffect(() => {
    if (uri) parseUri(decodeURIComponent(uri as string));
  }, [uri]);

  const parseUri = (raw: string) => {
    try {
      if (!raw.startsWith("web+stellar:")) {
        setParseError("Not a web+stellar URI"); return;
      }
      const opPart = raw.replace("web+stellar:", "");
      // Support both pay and tx operations
      const url = new URL(`web+stellar:${opPart}`);
      const params = new URLSearchParams(url.search);

      if (opPart.startsWith("pay")) {
        const dest = params.get("destination");
        const amount = params.get("amount");
        if (!dest || !amount) { setParseError("Missing destination or amount"); return; }
        setParsed({
          type: "payment",
          destination: dest,
          amount,
          memo: params.get("memo") || undefined,
        });
      } else if (opPart.startsWith("tx")) {
        const xdr = params.get("xdr");
        if (!xdr) { setParseError("Missing XDR parameter"); return; }
        // For tx operations, we parse the XDR to extract details
        try {
          const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as any;
          const ops = tx.operations?.() || [];
          if (ops.length > 0) {
            const op = ops[0];
            setParsed({
              type: "payment",
              destination: op.destination,
              amount: op.amount,
            });
            // Store XDR for direct signing
            (setParsed as any)._xdr = xdr;
          } else {
            setParseError("No operations in transaction");
          }
        } catch {
          setParseError("Invalid transaction XDR");
        }
      } else {
        setParseError(`Unsupported operation: ${opPart.split("?")[0]}`);
      }
    } catch (err: any) {
      setParseError(err?.message || "Failed to parse URI");
    }
  };

  const handleConfirm = async () => {
    if (!parsed || !publicKey) return;
    setSigning(true);
    try {
      const confirmed = await bio.confirmDonation(parseFloat(parsed.amount));
      if (!confirmed.success) { Alert.alert("Cancelled"); return; }

      const secretKey = await loadSecretKey();
      if (!secretKey) { Alert.alert("Error", "Could not access wallet keys."); return; }

      // Build and sign
      let xdr: string;
      if ((parsed as any)._xdr) {
        xdr = (parsed as any)._xdr;
      } else {
        const { buildPaymentTransaction } = require("../../lib/wallet/sdk");
        xdr = await buildPaymentTransaction({
          sourcePublicKey: publicKey,
          destination: parsed.destination,
          amount: parsed.amount,
          memo: parsed.memo,
        });
      }

      const { signedXDR } = signTransaction(xdr, secretKey);
      const txResult = await submitTransaction(signedXDR);
      setResult(`Transaction submitted! Hash: ${txResult.hash.slice(0, 12)}...`);
    } catch (err: any) {
      setResult(`Error: ${err?.message || "Transaction failed"}`);
    } finally {
      setSigning(false);
    }
  };

  if (!isAuthenticated || !publicKey) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Unlock your wallet to sign transactions.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.section}>
        <Text style={[styles.title, { color: colors.primaryText }]}>External Sign Request</Text>
        <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
          A dApp is requesting you sign a transaction.
        </Text>

        {parseError && (
          <View style={[styles.warningBox, { backgroundColor: "#fef2f2", borderColor: "#f87171" }]}>
            <Text style={[styles.errorText, { color: "#991b1b" }]}>{parseError}</Text>
          </View>
        )}

        {parsed && (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardLabel, { color: colors.secondaryText }]}>From</Text>
            <Text style={[styles.cardValue, { color: colors.primaryText }]} numberOfLines={1}>
              {publicKey.slice(0, 12)}...{publicKey.slice(-8)}
            </Text>
            <Text style={[styles.cardLabel, { color: colors.secondaryText, marginTop: 12 }]}>To</Text>
            <Text style={[styles.cardValue, { color: colors.primaryText }]} numberOfLines={1}>
              {parsed.destination.slice(0, 12)}...{parsed.destination.slice(-8)}
            </Text>
            <Text style={[styles.cardLabel, { color: colors.secondaryText, marginTop: 12 }]}>Amount</Text>
            <Text style={[styles.cardValue, { color: colors.primaryText }]}>{parsed.amount} XLM</Text>
            {parsed.memo && (
              <>
                <Text style={[styles.cardLabel, { color: colors.secondaryText, marginTop: 12 }]}>Memo</Text>
                <Text style={[styles.cardValue, { color: colors.primaryText }]}>{parsed.memo}</Text>
              </>
            )}
          </View>
        )}

        {result && (
          <View style={[styles.resultBox, { backgroundColor: result.startsWith("Error") ? "#fef2f2" : "#ecfdf5", borderColor: result.startsWith("Error") ? "#f87171" : "#34d399" }]}>
            <Text style={{ color: "#0f172a", fontSize: 14 }}>{result}</Text>
          </View>
        )}

        {parsed && !result && (
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: signing ? colors.muted : colors.primary }]}
            onPress={handleConfirm}
            disabled={signing}
          >
            {signing ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Confirm & Sign</Text>}
          </TouchableOpacity>
        )}

        {result && (
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, marginTop: 8 }]} onPress={() => router.back()}>
            <Text style={styles.btnText}>Done</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  emptyText: { fontSize: 16 },
  section: { padding: 24 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 4 },
  subtitle: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  warningBox: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16 },
  errorText: { fontSize: 14, fontWeight: "600" },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 16 },
  cardLabel: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", marginBottom: 2 },
  cardValue: { fontSize: 15, fontFamily: "monospace" },
  resultBox: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16 },
  btn: { padding: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
