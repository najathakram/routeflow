import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { Redirect } from "expo-router";
import Svg, { Path } from "react-native-svg";
import {
  Button,
  IconButton,
  MoneyField,
  PasswordField,
  TextArea,
  TextField,
  ThemeContext,
  buildNativeTheme,
  nativeOverline,
  nativeType,
  type ButtonVariant,
} from "@routeflow/ui/native";
import { ledgerSurface, type LedgerSurface } from "@routeflow/ui/ledger";

/**
 * DEV-ONLY kit gallery (#2331, plan §3 "kit gallery screen"): every kit A state on both
 * surfaces, captured at 390pt beside web `/dev/kit` for the side-by-side proof. It lives in
 * `(auth)` because unauthenticated users may already open that group, so the auth routing is not
 * touched. A release build redirects away.
 */
const VARIANTS: ButtonVariant[] = ["primary", "secondary", "ghost", "danger", "link"];

function PlusIcon(color: string) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={nativeOverline}>{title}</Text>
      {children}
    </View>
  );
}

function SurfaceGallery({ surface }: { surface: LedgerSurface }) {
  const [money, setMoney] = useState<number | null>(12.5);
  return (
    <ThemeContext.Provider value={buildNativeTheme({ surface })}>
      <View style={{ gap: 24, paddingVertical: 16 }}>
        <Text style={nativeType.heading2}>{surface} surface</Text>
        <Section title="Buttons · md">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {VARIANTS.map((v) => (
              <Button key={v} variant={v}>
                {v}
              </Button>
            ))}
          </View>
        </Section>
        <Section title="Sizes · states">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button loading>Saving</Button>
            <Button disabled>Disabled</Button>
            <Button variant="secondary" leftIcon={PlusIcon("#0f1b2d")}>
              New order
            </Button>
            <IconButton accessibilityLabel="Add" icon={PlusIcon} />
            <IconButton accessibilityLabel="Add" variant="secondary" icon={PlusIcon} />
          </View>
        </Section>
        <Section title="Fields">
          <TextField label="Business name" placeholder="Acme Market" />
          <TextField label="Email" value="buyer@acme.test" helper="We send order updates here." />
          <TextField label="Phone" value="555-01" error="Enter a full phone number." />
          <TextField label="Account code" value="ACME-01" disabled />
          <PasswordField label="Password" value="correct-horse" />
          <TextArea label="Delivery notes" placeholder="Side door, ring twice" />
          <MoneyField label="Unit price" value={money} onChangeValue={setMoney} />
        </Section>
      </View>
    </ThemeContext.Provider>
  );
}

export default function DevKitGallery() {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: ledgerSurface.canvas }}
      contentContainerStyle={{ padding: 16, gap: 8 }}
    >
      <SurfaceGallery surface="operator" />
      <SurfaceGallery surface="buyer" />
    </ScrollView>
  );
}
