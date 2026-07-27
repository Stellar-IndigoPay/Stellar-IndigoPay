/** Type stub for the deprecated expo-barcode-scanner module.
 *  The legacy QRScannerScreen.tsx uses this module, but the current
 *  implementation in app/scan.tsx uses expo-camera's built-in scanner.
 *  This stub prevents the need to install the deprecated package. */
declare module "expo-barcode-scanner" {
  export interface BarCodeScannerResult {
    type: string;
    data: string;
  }
  export const BarCodeScanner: React.ComponentType<any> & {
    Constants: { BarCodeType: Record<string, any> };
    requestPermissionsAsync: () => Promise<{ status: string }>;
  };
}
