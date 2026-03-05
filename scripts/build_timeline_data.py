from __future__ import annotations

import json
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


SITE_DIR = Path("/Users/nick/Documents/GitHub/nmalilay.github.io")
DATA_DIR = SITE_DIR / "data"
REPO_WORKBOOK = DATA_DIR / "Final Project Timeline.xlsx"
DOWNLOAD_WORKBOOK = Path("/Users/nick/Downloads/Final Project Timeline.xlsx")
TIMELINE_JSON = DATA_DIR / "la_walkability_timeline.json"

NS = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
SAMPLE_HEADLINES = {
    "Another Flickr Example",
    "Vimeo Example",
    "Wikipedia Example",
    "SoundCloud Example",
    "Simple Example",
}


def workbook_path() -> Path | None:
    if REPO_WORKBOOK.exists():
        return REPO_WORKBOOK
    if DOWNLOAD_WORKBOOK.exists():
        return DOWNLOAD_WORKBOOK
    return None


def cell_to_text(value: str) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.endswith(".0"):
        integer_part = text[:-2]
        if integer_part.lstrip("-").isdigit():
            return integer_part
    return text


def xlsx_rows(path: Path) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in shared_root.findall("main:si", NS):
                text = "".join(node.text or "" for node in item.iterfind(".//main:t", NS))
                shared_strings.append(text)

        workbook_root = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = workbook_root.find("main:sheets", NS)
        if sheets is None or len(sheets) == 0:
            return []
        first_sheet = sheets[0]
        rel_id = first_sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]

        rels_root = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        sheet_target = None
        for rel in rels_root:
            if rel.attrib.get("Id") == rel_id:
                sheet_target = rel.attrib["Target"]
                break
        if sheet_target is None:
            return []

        sheet_root = ET.fromstring(archive.read(f"xl/{sheet_target}"))
        rows = []
        for row in sheet_root.findall(".//main:sheetData/main:row", NS):
            row_data: dict[str, str] = {}
            for cell in row.findall("main:c", NS):
                ref = cell.attrib.get("r", "")
                column = "".join(char for char in ref if char.isalpha())
                value_node = cell.find("main:v", NS)
                value = value_node.text if value_node is not None else ""
                if cell.attrib.get("t") == "s" and value != "":
                    value = shared_strings[int(value)]
                row_data[column] = cell_to_text(value)
            rows.append(row_data)

    if not rows:
        return []

    headers = rows[0]
    ordered_columns = [headers.get(column, "") for column in sorted(headers)]
    parsed_rows = []
    for row in rows[1:]:
        parsed = {}
        for column_letter, header in zip(sorted(headers), ordered_columns):
            parsed[header] = row.get(column_letter, "").strip()
        if any(value for value in parsed.values()):
            parsed_rows.append(parsed)
    return parsed_rows


def has_real_workbook_content(rows: list[dict[str, str]]) -> bool:
    headlines = {row.get("Headline", "") for row in rows if row.get("Headline")}
    non_title = [row for row in rows if row.get("Type", "").lower() != "title"]
    if not non_title:
        return False
    if headlines and headlines.issubset(SAMPLE_HEADLINES | {"Walkability in Los Angeles"}):
        return False
    return True


def date_object(row: dict[str, str], prefix: str = "") -> dict[str, str] | None:
    mapping = {
        "year": row.get(f"{prefix}Year", ""),
        "month": row.get(f"{prefix}Month", ""),
        "day": row.get(f"{prefix}Day", ""),
        "time": row.get(f"{prefix}Time", ""),
    }
    cleaned = {key: value for key, value in mapping.items() if value}
    return cleaned or None


def media_object(url: str, credit: str = "", caption: str = "", thumbnail: str = "", alt: str = "") -> dict[str, str] | None:
    if not url:
        return None
    media = {"url": url}
    if credit:
        media["credit"] = credit
    if caption:
        media["caption"] = caption
    if thumbnail:
        media["thumbnail"] = thumbnail
    if alt:
        media["alt"] = alt
    return media


def background_object(value: str) -> dict[str, str] | None:
    if not value:
        return None
    if value.startswith("#"):
        return {"color": value}
    return {"url": value}


def workbook_timeline(rows: list[dict[str, str]]) -> dict:
    title_row = next((row for row in rows if row.get("Type", "").lower() == "title"), None)
    if title_row is None:
        title_row = {
            "Headline": "Walkability in Los Angeles",
            "Text": "Timeline imported from workbook",
        }

    events = []
    for row in rows:
        if row.get("Type", "").lower() == "title":
            continue
        event = {
            "text": {
                "headline": row.get("Headline", ""),
                "text": row.get("Text", ""),
            }
        }
        start = date_object(row)
        end = date_object(
            {
                "Year": row.get("End Year", ""),
                "Month": row.get("End Month", ""),
                "Day": row.get("End Day", ""),
                "Time": row.get("End Time", ""),
            }
        )
        if start:
            event["start_date"] = start
        if end:
            event["end_date"] = end
        if row.get("Display Date"):
            event["display_date"] = row["Display Date"]
        media = media_object(
            row.get("Media", ""),
            row.get("Media Credit", ""),
            row.get("Media Caption", ""),
            row.get("Media Thumbnail", ""),
            row.get("Alt Text", ""),
        )
        if media:
            event["media"] = media
        if row.get("Group"):
            event["group"] = row["Group"]
        background = background_object(row.get("Background", ""))
        if background:
            event["background"] = background
        events.append(event)

    title = {
        "text": {
            "headline": title_row.get("Headline", "Walkability in Los Angeles"),
            "text": title_row.get("Text", ""),
        }
    }
    title_media = media_object(
        title_row.get("Media", ""),
        title_row.get("Media Credit", ""),
        title_row.get("Media Caption", ""),
        title_row.get("Media Thumbnail", ""),
        title_row.get("Alt Text", ""),
    )
    if title_media:
        title["media"] = title_media
    title_background = background_object(title_row.get("Background", ""))
    if title_background:
        title["background"] = title_background

    return {"title": title, "events": events}


def fallback_timeline() -> dict:
    return {
        "title": {
            "media": {
                "url": "images/walkability_map.png",
                "caption": "LA County walkability map generated from the EPA Smart Location Database and Census-linked data.",
                "credit": "Project analysis",
                "alt": "LA County walkability map",
            },
            "text": {
                "headline": "Walkability in Los Angeles",
                "text": (
                    "<p>A timeline of planning decisions, environmental burdens, and research milestones that explain why "
                    "walkability is uneven across LA County.</p>"
                ),
            },
            "background": {"color": "#fff7ef"},
        },
        "events": [
            {
                "start_date": {"year": "1908"},
                "display_date": "1908",
                "group": "Planning history",
                "background": {"color": "#fff7ef"},
                "text": {
                    "headline": "Early zoning begins to structure opportunity",
                    "text": (
                        "<p>Los Angeles starts using land-use regulation in ways the city's Historical Housing and Land Use Study "
                        "later ties to racialized separation of housing, industry, and neighborhood investment.</p>"
                        "<p><a href=\"https://planning.lacity.gov/plans-policies/community-plan-update/housing-element-rezoning-program-news/historical-housing-and\">Historical Housing and Land Use Study</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "1940"},
                "display_date": "1940",
                "group": "Planning history",
                "background": {"color": "#fffaf5"},
                "text": {
                    "headline": "The Arroyo Seco Parkway opens",
                    "text": (
                        "<p>LADOT's transportation history identifies the Arroyo Seco Parkway as the nation's first freeway. "
                        "It marks the region's decisive turn toward auto-oriented mobility and corridor building.</p>"
                        "<p><a href=\"https://ladot.lacity.gov/sites/default/files/documents/transportation-topics-and-tales-milestones-in-transportation-history-in-southern-california.pdf\">Transportation Topics and Tales</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "1946", "month": "6", "day": "1"},
                "display_date": "June 1, 1946",
                "group": "Planning history",
                "background": {"color": "#fff7ef"},
                "text": {
                    "headline": "Los Angeles' original zoning code takes effect",
                    "text": (
                        "<p>The city's original zoning code goes into effect and helps lock land-use patterns into formal policy. "
                        "Those rules continue to influence where housing, jobs, and mobility options concentrate.</p>"
                        "<p><a href=\"https://planning.lacity.gov/plans-policies/community-plan-update/housing-element-rezoning-program-news/historical-housing-and\">Historical Housing and Land Use Study</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2014"},
                "display_date": "2014",
                "group": "Everyday walking",
                "background": {"color": "#f8fbff"},
                "text": {
                    "headline": "Walking to school in inner-city Los Angeles centers safety",
                    "text": (
                        "<p>Banerjee and coauthors show that children's walking experience in inner-city Los Angeles is shaped by "
                        "traffic danger, crime, and neighborhood disorder, not just sidewalk presence.</p>"
                        "<p><a href=\"https://journals.sagepub.com/doi/10.1177/0739456X14522494\">Banerjee et al. (2014)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2015"},
                "display_date": "2015",
                "group": "Travel behavior",
                "background": {"color": "#f8fbff"},
                "text": {
                    "headline": "LA trip-making studies link walkability to fewer car trips",
                    "text": (
                        "<p>Research on Los Angeles travel behavior finds that neighborhood walkability changes trip generation and "
                        "trip chaining, tying local street form to regional vehicle dependence.</p>"
                        "<p><a href=\"https://ascelibrary.org/doi/full/10.1061/%28ASCE%29UP.1943-5444.0000312\">Lee (2015)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2017"},
                "display_date": "2017",
                "group": "Equity",
                "background": {"color": "#f8fbff"},
                "text": {
                    "headline": "Socioeconomic context changes what walkability means",
                    "text": (
                        "<p>Adkins and colleagues argue that relationships between built environments and walking vary by "
                        "socioeconomic context, so the same street features do not produce the same mobility outcomes everywhere.</p>"
                        "<p><a href=\"https://doi.org/10.1080/01944363.2017.1322527\">Adkins et al. (2017)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2018"},
                "display_date": "2018",
                "group": "Parks and access",
                "background": {"color": "#f8fbff"},
                "text": {
                    "headline": "Safe routes to parks become an environmental justice question",
                    "text": (
                        "<p>Rigolon and coauthors examine who has more walkable routes to parks in Los Angeles, showing that "
                        "access to recreation depends on both neighborhood design and unequal exposure to street hazards.</p>"
                        "<p><a href=\"https://doi.org/10.1080/07352166.2017.1360740\">Rigolon et al. (2018)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2022"},
                "display_date": "2022",
                "group": "Climate",
                "background": {"color": "#eef8ff"},
                "text": {
                    "headline": "Heat research reframes walkability as climate exposure",
                    "text": (
                        "<p>Southern California temperature research shows that vegetation and land cover matter for street-level "
                        "heat, strengthening the link between walkability, shade, and climate resilience.</p>"
                        "<p><a href=\"https://iopscience.iop.org/article/10.1088/2515-7620/acabb8\">Engel et al. (2022)</a> and "
                        "<a href=\"https://doi.org/10.1002/2015JD023718\">Vahmani and Ban-Weiss (2016)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2023"},
                "display_date": "2023",
                "group": "Equity",
                "background": {"color": "#eef8ff"},
                "text": {
                    "headline": "Micro-level features explain walkability inequity in Los Angeles",
                    "text": (
                        "<p>Ki and Chen show that overlooked street-scale features help explain why headline walkability measures can "
                        "miss inequity within Los Angeles neighborhoods.</p>"
                        "<p><a href=\"https://www.sciencedirect.com/science/article/pii/S1361920923002857\">Ki and Chen (2023)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2023"},
                "display_date": "2023",
                "group": "Health",
                "background": {"color": "#eef8ff"},
                "text": {
                    "headline": "Asthma evidence ties built form to public health in LA",
                    "text": (
                        "<p>The Los Angeles asthma case study links built-environment conditions to asthma outcomes, pushing "
                        "walkability analysis beyond mobility into neighborhood health risk.</p>"
                        "<p><a href=\"https://doi.org/10.1007/s10389-020-01417-6\">Kim et al. (2023)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2024"},
                "display_date": "2024",
                "group": "Measurement",
                "background": {"color": "#eef8ff"},
                "text": {
                    "headline": "Behavioral data exposes the mismatch between walkability and walking",
                    "text": (
                        "<p>Mobile phone traces and street-view imagery show that walkability scores and actual walking behavior do "
                        "not always align, opening the door to more behavior-aware measurement.</p>"
                        "<p><a href=\"https://doi.org/10.1016/j.tra.2023.103946\">He and He (2024)</a></p>"
                    ),
                },
            },
            {
                "start_date": {"year": "2025"},
                "display_date": "2025",
                "group": "Measurement",
                "background": {"color": "#eef8ff"},
                "text": {
                    "headline": "Next-generation walkability metrics move to perception and AI",
                    "text": (
                        "<p>New work on perceived walkability and multimodal AI argues that future walkability measures should capture "
                        "what people actually see, feel, and do at street level, not only what coarse GIS variables can approximate.</p>"
                        "<p><a href=\"https://doi.org/10.1016/j.compenvurbsys.2025.102319\">Ki et al. (2025)</a> and "
                        "<a href=\"https://doi.org/10.1016/j.tra.2025.104498\">Van Der Vlugt et al. (2025)</a></p>"
                    ),
                },
            },
        ],
        "eras": [
            {
                "start_date": {"year": "1908"},
                "end_date": {"year": "1945"},
                "text": {"headline": "Land-use foundations"},
            },
            {
                "start_date": {"year": "1946"},
                "end_date": {"year": "1991"},
                "text": {"headline": "Auto-oriented expansion"},
            },
            {
                "start_date": {"year": "1992"},
                "end_date": {"year": "2025"},
                "text": {"headline": "Equity, health, and new measurement"},
            },
        ],
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    source = workbook_path()
    rows = xlsx_rows(source) if source else []
    timeline = workbook_timeline(rows) if has_real_workbook_content(rows) else fallback_timeline()
    TIMELINE_JSON.write_text(json.dumps(timeline, indent=2, ensure_ascii=True) + "\n")
    print(f"wrote {TIMELINE_JSON}")
    if source:
        print(f"source workbook: {source}")
    else:
        print("source workbook: not found, used fallback timeline")


if __name__ == "__main__":
    main()
