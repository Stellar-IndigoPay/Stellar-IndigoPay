import ExpoModulesCore
import Foundation
import Security
import LocalAuthentication
import CryptoKit

public class StellarSignerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("StellarSigner")

    AsyncFunction("generateKey") { (alias: String, promise: Promise) in
      do {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.rawRepresentation
        
        let query: [String: Any] = [
          kSecClass as String: kSecClassGenericPassword,
          kSecAttrAccount as String: alias,
          kSecValueData as String: privateKey.rawRepresentation,
          kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
          kSecUseAuthenticationUI as String: kSecUseAuthenticationUIAllow
        ]
        
        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        
        if status == errSecSuccess {
          promise.resolve(publicKey.base64EncodedString())
        } else {
          promise.reject("KEYCHAIN_ERROR", "Failed to save key to keychain")
        }
      } catch {
        promise.reject("KEY_GEN_ERROR", error.localizedDescription)
      }
    }

    AsyncFunction("getPublicKey") { (alias: String, promise: Promise) in
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: alias,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne
      ]
      
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      
      if status == errSecSuccess, let data = item as? Data {
        do {
          let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: data)
          promise.resolve(privateKey.publicKey.rawRepresentation.base64EncodedString())
        } catch {
          promise.reject("KEY_PARSE_ERROR", "Failed to parse key")
        }
      } else {
        promise.resolve(nil)
      }
    }

    AsyncFunction("sign") { (alias: String, dataBase64: String, reason: String, promise: Promise) in
      guard let data = Data(base64Encoded: dataBase64) else {
        promise.reject("INVALID_DATA", "Data is not valid base64")
        return
      }

      let context = LAContext()
      context.localizedReason = reason
      
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: alias,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecUseAuthenticationContext as String: context
      ]
      
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      
      if status == errSecSuccess, let keyData = item as? Data {
        do {
          let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: keyData)
          let signature = try privateKey.signature(for: data)
          promise.resolve(signature.base64EncodedString())
        } catch {
          promise.reject("SIGN_ERROR", error.localizedDescription)
        }
      } else {
        promise.reject("AUTH_FAILED", "Authentication failed or key not found")
      }
    }
  }
}
