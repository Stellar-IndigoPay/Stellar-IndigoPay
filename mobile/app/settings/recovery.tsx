import React, { useState } from 'react';
import { View, Text, Button, TextInput, StyleSheet, Alert } from 'react-native';
import { splitKeyAndStore, recoverKey, verifyKey, SplitResult } from '../../lib/wallet/recovery';
import { useAuth } from '../../providers/AuthProvider';

export default function RecoverySettings() {
  const { session } = useAuth();
  const [shares, setShares] = useState<SplitResult | null>(null);
  
  const [inputShare2, setInputShare2] = useState('');
  const [inputShare3, setInputShare3] = useState('');

  const handleSplit = async () => {
    if (!session?.secretKey) {
      Alert.alert("Error", "No secret key in session");
      return;
    }
    try {
      const result = await splitKeyAndStore(session.secretKey);
      setShares(result);
      Alert.alert("Success", "Key split and share 1 stored securely!");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  const handleRecover = async () => {
    if (!inputShare2 || !inputShare3) {
      Alert.alert("Error", "Please provide 2 additional shares");
      return;
    }
    try {
      const secret = await recoverKey([inputShare2, inputShare3]);
      const valid = await verifyKey(secret);
      if (valid) {
        Alert.alert("Success", "Key recovered successfully! \n" + secret.substring(0, 10) + "...");
      } else {
        Alert.alert("Error", "Recovered key does not match the stored public key.");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Shamir's Secret Sharing</Text>
      
      <Button title="Split My Key" onPress={handleSplit} />
      
      {shares && (
        <View style={styles.sharesContainer}>
          <Text style={styles.shareText}>Share 2 (Cloud): {shares.cloudShare}</Text>
          <Text style={styles.shareText}>Share 3 (Email): {shares.emailShare}</Text>
          <Text style={styles.shareText}>Share 4 (Manual): {shares.manualShare1}</Text>
          <Text style={styles.shareText}>Share 5 (Manual): {shares.manualShare2}</Text>
        </View>
      )}

      <Text style={styles.subtitle}>Recover Key</Text>
      <TextInput 
        style={styles.input} 
        placeholder="Enter Share 2" 
        value={inputShare2} 
        onChangeText={setInputShare2} 
      />
      <TextInput 
        style={styles.input} 
        placeholder="Enter Share 3" 
        value={inputShare3} 
        onChangeText={setInputShare3} 
      />
      
      <Button title="Recover Key" onPress={handleRecover} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  subtitle: { fontSize: 20, fontWeight: 'bold', marginTop: 30, marginBottom: 10 },
  sharesContainer: { marginTop: 20, padding: 10, backgroundColor: '#f0f0f0', borderRadius: 8 },
  shareText: { marginBottom: 10, fontFamily: 'monospace' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10, borderRadius: 5 }
});
