from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import geopandas as gpd
from matplotlib.colors import LinearSegmentedColormap

DATA_CSV = Path("/Users/nick/Downloads/dgt hum 101/Data/LA_SLD_ACS_Cleaned.csv")
SHAPEFILE = Path("/Users/nick/Downloads/dgt hum 101/Data/tiger_line_2019_SLD_joined/tiger_line_2019_SLD_joined.shp")
OUT_DIR = Path("/Users/nick/Documents/GitHub/nmalilay.github.io/images")

OUT_DIR.mkdir(parents=True, exist_ok=True)

PALETTE = {
    "asphalt": "#111827",
    "slate": "#94a3b8",
    "park": "#22c55e",
    "transit": "#38bdf8",
    "signal": "#facc15",
    "brick": "#ef4444",
    "grid": "#e2e8f0",
}

plt.rcParams.update(
    {
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.edgecolor": PALETTE["grid"],
        "axes.labelcolor": PALETTE["asphalt"],
        "xtick.color": "#475569",
        "ytick.color": "#475569",
        "grid.color": PALETTE["grid"],
        "grid.linewidth": 0.6,
        "font.size": 10,
        "svg.fonttype": "none",
    }
)


def load_data() -> pd.DataFrame:
    df = pd.read_csv(DATA_CSV)
    return df


def save_histogram(df: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(6, 3.2))
    ax.hist(df["NatWalkInd"].dropna(), bins=30, color=PALETTE["park"], alpha=0.85)
    ax.set_title("Distribution of National Walkability Index")
    ax.set_xlabel("NatWalkInd")
    ax.set_ylabel("Block groups")
    ax.grid(axis="y", alpha=0.7)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "walkability_hist.svg")
    plt.close(fig)


def save_boxplot(df: pd.DataFrame) -> None:
    fig, ax = plt.subplots(figsize=(6.2, 3.2))
    grouped = [g["NatWalkInd"].dropna().values for _, g in df.groupby("CBSA_Name")]
    labels = [name.replace(", CA", "") for name, _ in df.groupby("CBSA_Name")]
    bp = ax.boxplot(grouped, tick_labels=labels, patch_artist=True, widths=0.5)
    for box in bp["boxes"]:
        box.set(facecolor=PALETTE["transit"], alpha=0.6, edgecolor=PALETTE["asphalt"])
    for median in bp["medians"]:
        median.set(color=PALETTE["asphalt"], linewidth=1.5)
    ax.set_title("Walkability by CBSA")
    ax.set_ylabel("NatWalkInd")
    ax.grid(axis="y", alpha=0.7)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "walkability_by_cbsa_boxplot.svg")
    plt.close(fig)


def scatter_with_trend(x: np.ndarray, y: np.ndarray, xlabel: str, ylabel: str, title: str, filename: str, color: str) -> None:
    fig, ax = plt.subplots(figsize=(6, 3.6))
    ax.scatter(x, y, s=10, alpha=0.35, color=color, edgecolors="none")
    mask = np.isfinite(x) & np.isfinite(y)
    if mask.sum() > 2:
        coeffs = np.polyfit(x[mask], y[mask], 1)
        x_line = np.linspace(x[mask].min(), x[mask].max(), 200)
        y_line = coeffs[0] * x_line + coeffs[1]
        ax.plot(x_line, y_line, color=PALETTE["asphalt"], linewidth=1.5)
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.grid(alpha=0.7)
    fig.tight_layout()
    fig.savefig(OUT_DIR / filename)
    plt.close(fig)


def save_heatmap(df: pd.DataFrame) -> None:
    cols = ["NatWalkInd", "Pct_AO0", "D4A", "R_PCTLOWWAGE", "TotPop"]
    corr = df[cols].corr()

    fig, ax = plt.subplots(figsize=(5.4, 4.2))
    cmap = LinearSegmentedColormap.from_list("walk_div", ["#0ea5e9", "#f8fafc", "#ef4444"])
    im = ax.imshow(corr, cmap=cmap, vmin=-1, vmax=1)
    ax.set_xticks(range(len(cols)), labels=cols, rotation=35, ha="right")
    ax.set_yticks(range(len(cols)), labels=cols)

    for i in range(len(cols)):
        for j in range(len(cols)):
            ax.text(j, i, f"{corr.iloc[i, j]:.2f}", ha="center", va="center", fontsize=8, color=PALETTE["asphalt"])

    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    ax.set_title("Correlation Heatmap")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "correlation_heatmap.svg")
    plt.close(fig)


def save_case_study(df: pd.DataFrame) -> None:
    q10 = df["NatWalkInd"].quantile(0.1)
    q90 = df["NatWalkInd"].quantile(0.9)
    low = df[df["NatWalkInd"] <= q10]
    high = df[df["NatWalkInd"] >= q90]

    metrics = [
        ("NatWalkInd", "Walkability Score"),
        ("Pct_AO0", "Car-free Share (%)"),
        ("D4A", "Transit Access (D4A)"),
        ("median_household_income", "Median HH Income ($)"),
    ]

    fig, axes = plt.subplots(2, 2, figsize=(7.2, 5.2))
    axes = axes.ravel()

    for ax, (col, label) in zip(axes, metrics):
        high_val = high[col].mean()
        low_val = low[col].mean()
        if col == "Pct_AO0":
            high_val *= 100
            low_val *= 100
        ax.bar([0, 1], [high_val, low_val], color=[PALETTE["park"], PALETTE["brick"]], width=0.6)
        ax.set_xticks([0, 1], labels=["Top 10%", "Bottom 10%"])
        ax.set_title(label)
        ax.grid(axis="y", alpha=0.7)

        if col == "median_household_income":
            ax.ticklabel_format(axis="y", style="plain")

    fig.suptitle("Case Study: Top vs Bottom Walkability Deciles", y=1.02)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "case_study_comparison.svg")
    plt.close(fig)


def save_map() -> None:
    gdf = gpd.read_file(SHAPEFILE)
    if "NatWalkInd" not in gdf.columns:
        df = load_data()
        gdf = gdf.merge(df[["GEOID20", "NatWalkInd"]], left_on="GEOID20", right_on="GEOID20", how="left")

    gdf = gdf.dropna(subset=["NatWalkInd"]).copy()

    fig, ax = plt.subplots(figsize=(6.2, 7.4))
    gdf.plot(
        ax=ax,
        column="NatWalkInd",
        cmap="YlGn",
        linewidth=0,
        antialiased=False,
    )
    ax.set_axis_off()
    sm = plt.cm.ScalarMappable(cmap="YlGn", norm=plt.Normalize(vmin=gdf["NatWalkInd"].min(), vmax=gdf["NatWalkInd"].max()))
    sm._A = []
    cbar = fig.colorbar(sm, ax=ax, fraction=0.03, pad=0.01)
    cbar.set_label("NatWalkInd")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "walkability_map.png", dpi=200)
    plt.close(fig)


def main() -> None:
    df = load_data()
    save_histogram(df)
    save_boxplot(df)
    scatter_with_trend(
        df["Pct_AO0"].to_numpy(),
        df["D4A"].to_numpy(),
        "Car-free households (Pct_AO0)",
        "Transit access (D4A)",
        "Car-free Households vs Transit Access",
        "carfree_vs_transit.svg",
        PALETTE["transit"],
    )
    scatter_with_trend(
        df["R_PCTLOWWAGE"].to_numpy(),
        df["NatWalkInd"].to_numpy(),
        "Low-wage share (R_PCTLOWWAGE)",
        "Walkability (NatWalkInd)",
        "Low-wage Share vs Walkability",
        "lowwage_vs_walkability.svg",
        PALETTE["brick"],
    )
    save_heatmap(df)
    save_case_study(df)
    save_map()


if __name__ == "__main__":
    main()
