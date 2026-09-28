/**
 * Structured data (JSON-LD, plus a glance at microdata): which schema.org
 * types the page declares, and whether a local business carries the
 * fields an assistant needs to name it correctly.
 */
import type { ParsedPage } from "./html.js";

/** schema.org LocalBusiness and the subtypes a small business actually uses. */
const BUSINESS_TYPES = new Set(
  [
    "LocalBusiness", "Organization", "Corporation", "ProfessionalService", "Store", "OnlineStore", "Restaurant", "CafeOrCoffeeShop",
    "BarOrPub", "Bakery", "FoodEstablishment", "FastFoodRestaurant", "IceCreamShop", "Winery", "Brewery",
    "LodgingBusiness", "Hotel", "Hostel", "Motel", "BedAndBreakfast", "Resort", "VacationRental", "Campground",
    "RealEstateAgent", "TravelAgency", "Dentist", "Physician", "MedicalClinic", "MedicalBusiness", "Optician", "Pharmacy",
    "VeterinaryCare", "HealthAndBeautyBusiness", "BeautySalon", "HairSalon", "NailSalon", "DaySpa", "TattooParlor",
    "SportsActivityLocation", "ExerciseGym", "HealthClub", "LegalService", "Attorney", "Notary", "AccountingService",
    "FinancialService", "InsuranceAgency", "AutomotiveBusiness", "AutoRepair", "AutoDealer", "HomeAndConstructionBusiness",
    "Electrician", "Plumber", "RoofingContractor", "HousePainter", "Locksmith", "MovingCompany", "GeneralContractor",
    "HVACBusiness", "EntertainmentBusiness", "ChildCare", "EducationalOrganization", "School", "EmploymentAgency",
    "ShoppingCenter", "ClothingStore", "Florist", "FurnitureStore", "GardenStore", "HardwareStore", "JewelryStore",
    "BookStore", "ElectronicsStore", "PetStore", "SportingGoodsStore", "ToyStore", "GroceryStore", "LiquorStore",
    "TouristAttraction", "TouristInformationCenter", "ArtGallery", "Museum", "NightClub", "EventVenue", "Photographer",
  ].map((t) => t.toLowerCase()),
);

export interface BusinessData {
  type: string;
  name: string | null;
  address: string | null;
  telephone: string | null;
  openingHours: boolean;
  /** Which of name/address/telephone/openingHours are missing. */
  missing: Array<"name" | "address" | "telephone" | "openingHours">;
}

export interface StructuredResult {
  types: string[];
  business: BusinessData | null;
  faq: { questions: number } | null;
  /** JSON-LD blocks that are not valid JSON. */
  invalidBlocks: number;
  microdataTypes: string[];
}

type Node = Record<string, unknown>;

function typesOf(n: Node): string[] {
  const t = n["@type"];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  return list.map((x) => String(x).replace(/^https?:\/\/schema\.org\//, ""));
}

function flatten(value: unknown, out: Node[], depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out, depth + 1);
    return;
  }
  const n = value as Node;
  if (n["@type"]) out.push(n);
  for (const [k, v] of Object.entries(n)) {
    if (k === "@context") continue;
    if (typeof v === "object") flatten(v, out, depth + 1);
  }
}

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return text(v[0]);
  if (v && typeof v === "object") {
    const n = v as Node;
    if (typeof n.name === "string") return n.name;
  }
  return null;
}

function addressText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return addressText(v[0]);
  if (v && typeof v === "object") {
    const a = v as Node;
    const parts = [a.streetAddress, a.postalCode, a.addressLocality, a.addressRegion, a.addressCountry]
      .map((p) => (typeof p === "string" ? p : text(p)))
      .filter((p): p is string => !!p && p.trim() !== "");
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

export function readStructuredData(page: ParsedPage): StructuredResult {
  const nodes: Node[] = [];
  let invalidBlocks = 0;
  for (const block of page.jsonLd) {
    try {
      // Some sites wrap JSON-LD in CDATA or HTML comments.
      flatten(JSON.parse(block.replace(/^\s*(<!--|\/\*<!\[CDATA\[\*\/)|(-->|\/\*\]\]>\*\/)\s*$/g, "")), nodes);
    } catch {
      invalidBlocks++;
    }
  }
  const types = [...new Set(nodes.flatMap(typesOf))];
  const microdataTypes = [...new Set(page.itemTypes.map((t) => t.replace(/^https?:\/\/schema\.org\//, "")))];

  const bizNode =
    nodes.find((n) => typesOf(n).some((t) => BUSINESS_TYPES.has(t.toLowerCase()) && t !== "Organization")) ??
    nodes.find((n) => typesOf(n).includes("Organization"));
  let business: BusinessData | null = null;
  if (bizNode) {
    const name = text(bizNode.name);
    const address = addressText(bizNode.address) ?? addressText((bizNode.location as Node | undefined)?.address);
    const telephone = text(bizNode.telephone);
    const openingHours = !!(bizNode.openingHoursSpecification || bizNode.openingHours);
    const isOrgOnly = typesOf(bizNode).every((t) => ["Organization", "Corporation", "OnlineStore"].includes(t));
    const missing: BusinessData["missing"] = [];
    if (!name) missing.push("name");
    if (!address && !isOrgOnly) missing.push("address");
    if (!telephone) missing.push("telephone");
    if (!openingHours && !isOrgOnly) missing.push("openingHours");
    business = { type: typesOf(bizNode)[0], name, address, telephone, openingHours, missing };
  }

  const faqNode = nodes.find((n) => typesOf(n).includes("FAQPage"));
  const faq = faqNode
    ? { questions: (Array.isArray(faqNode.mainEntity) ? faqNode.mainEntity : faqNode.mainEntity ? [faqNode.mainEntity] : []).length }
    : null;

  return { types, business, faq, invalidBlocks, microdataTypes };
}
