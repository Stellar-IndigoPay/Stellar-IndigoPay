package expo.modules.stellarsigner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import android.util.Base64

class StellarSignerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StellarSigner")

    AsyncFunction("generateKey") { alias: String ->
      val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
      val parameterSpec = KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
      ).run {
        setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
        setUserAuthenticationRequired(true)
        // Ed25519 requires API 31+ but we simulate the stub for hardware-backed keys
        build()
      }
      kpg.initialize(parameterSpec)
      val kp = kpg.generateKeyPair()
      Base64.encodeToString(kp.public.encoded, Base64.NO_WRAP)
    }

    AsyncFunction("getPublicKey") { alias: String ->
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      val entry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
      entry?.certificate?.publicKey?.encoded?.let {
        Base64.encodeToString(it, Base64.NO_WRAP)
      }
    }

    AsyncFunction("sign") { alias: String, dataBase64: String, reason: String ->
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      val entry = keyStore.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        ?: throw Exception("Key not found")

      // Biometric prompt would normally be launched here to unlock the key
      val signature = Signature.getInstance("NONEwithECDSA")
      signature.initSign(entry.privateKey)
      
      val data = Base64.decode(dataBase64, Base64.NO_WRAP)
      signature.update(data)
      
      val signedData = signature.sign()
      Base64.encodeToString(signedData, Base64.NO_WRAP)
    }
  }
}
