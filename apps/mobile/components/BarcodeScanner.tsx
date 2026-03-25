import * as React from "react";
import { StyleSheet, View, Text, TouchableOpacity, Dimensions } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const WINDOW_SIZE = SCREEN_WIDTH * 0.7;

interface Props {
  onScanned: (code: string) => void;
  onClose: () => void;
}

export function BarcodeScanner({ onScanned, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const firedRef = React.useRef(false);

  React.useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, []);

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (firedRef.current) return;
    firedRef.current = true;
    onScanned(data);
  };

  if (!permission?.granted) {
    return (
      <View style={styles.overlay}>
        <View style={styles.permissionBox}>
          <Text style={styles.permissionTitle}>Camera Access Required</Text>
          <Text style={styles.permissionBody}>
            Allow camera access to scan barcodes.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Grant Access</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 12 }}>
            <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 14 }}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{
          barcodeTypes: ["ean13", "ean8", "code128", "qr", "upc_a", "upc_e", "code39"],
        }}
        onBarcodeScanned={handleBarCodeScanned}
      />

      {/* Dark surround */}
      <View style={styles.overlay} pointerEvents="box-none">
        {/* Top dark */}
        <View style={[styles.dark, { height: (SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40 }]} />

        {/* Middle row */}
        <View style={{ flexDirection: "row", height: WINDOW_SIZE }}>
          <View style={[styles.dark, { flex: 1 }]} />
          {/* Clear scan window */}
          <View style={styles.scanWindow} />
          <View style={[styles.dark, { flex: 1 }]} />
        </View>

        {/* Bottom dark */}
        <View style={[styles.dark, { flex: 1 }]}>
          <Text style={styles.hint}>Align barcode within the box</Text>
        </View>
      </View>

      {/* Close button */}
      <TouchableOpacity style={styles.closeButton} onPress={onClose}>
        <Ionicons name="close" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "column",
  },
  dark: {
    backgroundColor: "rgba(0,0,0,0.65)",
    alignItems: "center",
    justifyContent: "center",
  },
  scanWindow: {
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.8)",
    borderRadius: 12,
  },
  hint: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 14,
    marginTop: 16,
  },
  closeButton: {
    position: "absolute",
    top: 54,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  permissionBox: {
    backgroundColor: "rgba(0,0,0,0.85)",
    margin: 32,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginTop: "auto",
    marginBottom: "auto",
  },
  permissionTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 8,
  },
  permissionBody: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
  },
  permissionButton: {
    backgroundColor: "#3b82f6",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
});
