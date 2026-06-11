// decode.js — human-readable expansions for SATCAT codes.
// Not exhaustive; unknown codes fall through and display raw.

export const OWNERS = {
  US: 'United States', CIS: 'Russia (CIS)', PRC: 'China', UK: 'United Kingdom',
  FR: 'France', GER: 'Germany', IND: 'India', JPN: 'Japan', IT: 'Italy',
  CA: 'Canada', ESA: 'European Space Agency', EUME: 'EUMETSAT',
  EUTE: 'EUTELSAT', INTL: 'Intelsat', ORB: 'Orbcomm', SES: 'SES',
  GLOB: 'Globalstar', IRID: 'Iridium', O3B: 'O3b Networks',
  ISRO: 'India (ISRO)', SKOR: 'South Korea', NKOR: 'North Korea',
  TWN: 'Taiwan', ISRA: 'Israel', IRAN: 'Iran', TURK: 'Turkey',
  UAE: 'United Arab Emirates', SAUD: 'Saudi Arabia', EGYP: 'Egypt',
  BRAZ: 'Brazil', ARGN: 'Argentina', MEX: 'Mexico', CHLE: 'Chile',
  SPN: 'Spain', NETH: 'Netherlands', BEL: 'Belgium', LUXE: 'Luxembourg',
  NOR: 'Norway', SWED: 'Sweden', DEN: 'Denmark', FIN: 'Finland',
  POL: 'Poland', CZCH: 'Czechia', HUN: 'Hungary', UKR: 'Ukraine',
  AUS: 'Australia', NZ: 'New Zealand', INDO: 'Indonesia', MALA: 'Malaysia',
  SING: 'Singapore', THAI: 'Thailand', VTNM: 'Vietnam', PAKI: 'Pakistan',
  KAZ: 'Kazakhstan', BELA: 'Belarus', AZER: 'Azerbaijan', SAFR: 'South Africa',
  NIG: 'Nigeria', ALG: 'Algeria', MORO: 'Morocco', QAT: 'Qatar',
  AB: 'Arab Satellite Comm. Org.', AC: 'Asia Satellite Telecom (AsiaSat)',
  SEAL: 'Sea Launch', IM: 'Inmarsat', NATO: 'NATO', RASC: 'RascomStar-QAF',
  STCT: 'Singapore/Taiwan', FGER: 'France/Germany', USBZ: 'US/Brazil',
};

export const LAUNCH_SITES = {
  AFETR: 'Cape Canaveral / Eastern Range, Florida, USA',
  AFWTR: 'Vandenberg / Western Range, California, USA',
  KSCUT: 'Kennedy Space Center (Uchinoura?), USA',
  ERAS: 'Eastern Range Airspace (air launch), USA',
  WRAS: 'Western Range Airspace (air launch), USA',
  WLPIS: 'Wallops Island, Virginia, USA',
  KODAK: 'Kodiak Island, Alaska, USA',
  CCSFS: 'Cape Canaveral Space Force Station, Florida, USA',
  TYMSC: 'Baikonur Cosmodrome, Kazakhstan',
  PLMSC: 'Plesetsk Cosmodrome, Russia',
  VOSTO: 'Vostochny Cosmodrome, Russia',
  KYMSC: 'Kapustin Yar, Russia',
  SVOBO: 'Svobodny Cosmodrome, Russia',
  JSC: 'Jiuquan Satellite Launch Center, China',
  XSC: 'Xichang Satellite Launch Center, China',
  TAISC: 'Taiyuan Satellite Launch Center, China',
  WSC: 'Wenchang Space Launch Site, China',
  YUN: 'Yellow Sea platform, China',
  HAISC: 'Hainan commercial site, China',
  FRGUI: 'Guiana Space Centre, Kourou, French Guiana',
  HGSTR: 'Hammaguir, Algeria',
  SRILR: 'Satish Dhawan Space Centre, Sriharikota, India',
  TANSC: 'Tanegashima Space Center, Japan',
  KSCUT2: 'Uchinoura Space Center, Japan',
  USC: 'Uchinoura Space Center, Japan',
  KWAJ: 'Kwajalein Atoll / Reagan Test Site',
  RLLB: 'Rocket Lab LC-1, Mahia, New Zealand',
  SEAL2: 'Sea Launch platform (Pacific)',
  SEMLS: 'Semnan, Iran',
  YAVNE: 'Palmachim, Israel',
  SNMLP: 'San Marco platform, Kenya',
  WOMRA: 'Woomera, Australia',
  NSC: 'Naro Space Center, South Korea',
  SADOL: 'Submarine launch, Barents Sea',
  OREN: 'Orenburg / Yasny (Dombarovsky), Russia',
};

export function decodeOwner(code) {
  return OWNERS[code] || code || 'Unknown';
}
export function decodeSite(code) {
  return LAUNCH_SITES[code] || code || 'Unknown';
}
