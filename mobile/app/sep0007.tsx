import { useEffect, useMemo, useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import * as LocalAuthentication from "expo-local-authentication";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../providers/AuthProvider";
import { loadSecretKey, buildPaymentTransaction, signTransaction, submitTransaction } from "../lib/wallet/sdk";
import { parseSEP0007Params, validateSEP0007Params } from "../utils/sep0007";
import { addToHistory } from "../utils/scanHistory";

export default function SEP0007Screen() {
  const deepLinkUrl = Linking.useURL();
  const { uri } = useLocalSearchParams<{ uri?: string }>();
  const router = useRouter();
  const { session, isAuthenticated } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    if (typeof uri === "string" && uri) return decodeURIComponent(uri);
    return deepLinkUrl || null;
  }, [deepLinkUrl, uri]);

  const params = useMemo(() => parseSEP0007Params(url), [url]);
  const validationErrors = useMemo(() => validateSEP0007Params(params), [params]);

  useEffect(() => {
    if (params.destination && validationErrors.length === 0) {
      setError(null);
    }
  }, [params, validationErrors]);

  const handleSubmit = async () => {
    if (!params.destination || validationErrors.length > 0) {
      setError("Invalid payment request");
      return;
    }

    if (!isAuthenticated || !session?.publicKey) {
      setError("Unlock your wallet to continue");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const authenticated = await LocalAuthentication.authenticateAsync({
        promptMessage: "Confirm payment",
        fallbackLabel: "Use passcode",
      });
      if (!authenticated.success) {
        setError("Authentication cancelled");
        return;
      }

      const secretKey = await loadSecretKey();
      if (!secretKey) {
        setError("Unable to access wallet secret key");
        return;
      }

      const xdr = await buildPaymentTransaction({
        sourcePublicKey: session.publicKey,
        destination: params.destination,
        amount: params.amount || "1",
        memo: params.memo,
      });
      const { signedXDR, transactionHash } = signTransaction(xdr, secretKey);
      const result = await submitTransaction(signedXDR);

      try {
        await addToHistory({
          type: "sep0007",
          address: params.destination,
          amount: params.amount,
          memo: params.memo,
          timestamp: Date.now(),
          raw: url || "",
        });
      } catch {
        // History persistence is best-effort and should not block payments.
      }

      if (params.callback) {
        const callbackUrl = new URL(params.callback);
        callbackUrl.searchParams.set("txHash", result.hash || transactionHash);
        await Linking.openURL(callbackUrl.toString());
      }

      router.replace(`/donate/success?txHash=${result.hash || transactionHash}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Payment failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isAuthenticated || !session?.publicKey) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Unlock your wallet</Text>
        <Text style={styles.subtitle}>Unlock your wallet to continue with this payment request.</Text>
      </View>
    );
  }

  if (validationErrors.length > 0 || !params.destination) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Invalid payment request</Text>
        <Text style={styles.subtitle}>The payment link is missing required information.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Payment request</Text>
      <Text style={styles.subtitle}>Review the payment details and confirm to continue.</Text>
      <View style={styles.card}>
        <Text style={styles.label}>Destination</Text>
        <Text style={styles.value}>{params.destination}</Text>
        <Text style={styles.label}>Amount</Text>
        <Text style={styles.value}>{params.amount || "1"} {params.asset_code || "XLM"}</Text>
        {params.memo ? <><Text style={styles.label}>Memo</Text><Text style={styles.value}>{params.memo}</Text></> : null}
        {params.message ? <><Text style={styles.label}>Message</Text><Text style={styles.value}>{params.message}</Text></> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title={submitting ? "Processing..." : "Confirm & Pay"} onPress={handleSubmit} disabled={submitting} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  subtitle: { fontSize: 16, color: "#4b5563", marginBottom: 20 },
  card: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 12, padding: 16, marginBottom: 16 },
  label: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginTop: 8 },
  value: { fontSize: 15, marginTop: 4 },
  error: { color: "#b91c1c", marginBottom: 12 },
});
