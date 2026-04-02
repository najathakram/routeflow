"use client";

import * as React from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell,
  LineChart, Line,
  ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

interface ReportChartProps {
  type: "bar" | "pie" | "line" | "stacked-bar";
  data: Record<string, unknown>[];
  dataKeys: string[];
  nameKey?: string;
  colors?: string[];
  height?: number;
  horizontal?: boolean;
  formatValue?: (value: number) => string;
}

const currencyFormatter = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value);

export function ReportChart({
  type,
  data,
  dataKeys,
  nameKey = "name",
  colors = COLORS,
  height = 340,
  horizontal = false,
  formatValue = currencyFormatter,
}: ReportChartProps) {
  if (!data || data.length === 0) return null;

  const tooltipStyle = {
    contentStyle: {
      backgroundColor: "#fff",
      border: "1px solid #e5e7eb",
      borderRadius: "8px",
      fontSize: "13px",
      boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
    },
  };

  if (type === "pie") {
    return (
      <div className="rounded-lg border border-surface-border bg-white p-4">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              outerRadius={Math.floor(height * 0.3)}
              dataKey={dataKeys[0]}
              nameKey={nameKey}
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
              labelLine={false}
            >
              {data.map((_, idx) => (
                <Cell key={idx} fill={colors[idx % colors.length]} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} formatter={(value: number) => formatValue(value)} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (type === "line") {
    return (
      <div className="rounded-lg border border-surface-border bg-white p-4">
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey={nameKey} tick={{ fontSize: 12, fill: "#64748b" }} />
            <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={formatValue} />
            <Tooltip {...tooltipStyle} formatter={(value: number) => formatValue(value)} />
            <Legend />
            {dataKeys.map((key, idx) => (
              <Line key={key} type="monotone" dataKey={key} stroke={colors[idx % colors.length]} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Bar or stacked-bar
  const layout = horizontal ? "vertical" : "horizontal";
  return (
    <div className="rounded-lg border border-surface-border bg-white p-4">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout={layout}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          {horizontal ? (
            <>
              <XAxis type="number" tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={formatValue} />
              <YAxis dataKey={nameKey} type="category" tick={{ fontSize: 12, fill: "#64748b" }} width={160} />
            </>
          ) : (
            <>
              <XAxis dataKey={nameKey} tick={{ fontSize: 12, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 12, fill: "#64748b" }} tickFormatter={formatValue} />
            </>
          )}
          <Tooltip {...tooltipStyle} formatter={(value: number) => formatValue(value)} />
          <Legend />
          {dataKeys.map((key, idx) => (
            <Bar
              key={key}
              dataKey={key}
              fill={colors[idx % colors.length]}
              stackId={type === "stacked-bar" ? "stack" : undefined}
              radius={type === "stacked-bar" ? undefined : [4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
