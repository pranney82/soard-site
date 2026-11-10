/**
 * Who issues residential building permits in each town and county SOARD has homes in (./_permit-office.js)
 * ===========================================================================
 * Keyed by the jurisdiction the Census map gives a home ("City of Mableton", "Cobb County"). office: what the
 * home's Permitting Municipality says; source: the government's own page or filed agreement that says so;
 * checked: when. Most issue their own. The one that doesn't (Nov 2026): Hamilton, whose building codes Harris
 * County enforces under the county's service delivery agreement. A town missing here is written as itself and
 * Site → Automations asks for a look; staff can also teach the site by changing one home in JobTread.
 *
 * Worth knowing when one changes: new cities take permits over from their county on a set date (Mableton from
 * Cobb on Mar 1 2025, Mulberry from Gwinnett on Jan 1 2025), and a county's service delivery agreement with its
 * small towns is renewed every ten years or so (dca.georgia.gov keeps them).
 */
const CHECKED = '2026-11-09';
const own = (name, source) => [name, { office: name, source, checked: CHECKED }];

export const VERIFIED = Object.fromEntries([
  // Cities and towns: the home is inside these city limits
  own('City of Alpharetta', 'https://www.alpharetta.ga.us/construction-inspections'),
  own('City of Atlanta', 'https://www.atlantaga.gov/government/departments/city-planning/about-dcp/office-of-buildings'),
  own('City of Austell', 'https://austellga.gov/CommunityDevelopment.aspx'),
  own('City of Brookhaven', 'https://www.brookhavenga.gov/291/New-Single-Family-Home---Residential'),
  own('City of Douglasville', 'https://www.douglasvillega.gov/Departments/Community-Development/Building-Division'),
  own('City of Dunwoody', 'https://www.dunwoodyga.gov/government/departments/community-development/permits-inspections/residential-single-family'),
  ['City of Hamilton', { office: 'Harris County', source: 'https://dca.georgia.gov/document/plans/2010-harris-county-service-delivery-strategy/download', checked: CHECKED,
    note: 'Harris County’s Office of Community Development enforces the City of Hamilton’s State minimum Building Codes (2010 service delivery strategy, extended without change in 2019). Harris County Community Development: 706-628-4700.' }],
  own('City of Hampton', 'https://hamptonga.gov/departments/community-development'),
  own('City of Holly Springs', 'https://www.hollyspringsga.us/168/Community-Development'),
  own('City of Jefferson', 'https://www.jeffersonga.gov/219/Building-Permits-Certificates-of-Occupan'),
  own('City of Johns Creek', 'https://johnscreekga.gov/departments/community-development/building-permitting/'),
  own('City of Kennesaw', 'https://www.kennesaw-ga.gov/buildingservices/'),
  own('City of Lawrenceville', 'https://www.lawrencevillega.org/249/Building-Permits'),
  own('City of Mableton', 'https://www.cobbcounty.gov/community-development/building-development/codes-standards-guidelines'),
  own('City of McDonough', 'https://www.mcdonoughga.org/198/Building-Inspection-Division'),
  own('City of Mulberry', 'https://www.mulberryga.gov/167/Permitting'),
  own('City of Newnan', 'https://www.newnanga.gov/163/Building-Department'),
  own('City of Roswell', 'https://www.roswellgov.com/government/departments-division/community-development/building/'),
  own('City of Sandy Springs', 'https://www.sandyspringsga.gov/residential-building-permits'),
  own('City of Smyrna', 'https://www.smyrnaga.gov/business/community-development/building-division'),
  own('City of Snellville', 'https://www.snellville.gov/planning-and-development/building-development-permitting'),
  own('City of South Fulton', 'https://www.cityofsouthfultonga.gov/2852/Building-Permits'),
  own('City of Stockbridge', 'https://stockbridgega.org/departments/community-development'),
  own('City of Union City', 'https://www.unioncityga.gov/Departments/Community-Development/Permits'),
  own('City of Woodstock', 'https://www.woodstockga.gov/your_government/departments/community_development/building.php'),
  own('Town of Braselton', 'https://www.braselton.gov/departments/planning/building_permit_applications_and_information.php'),
  // Counties: the home is outside any city, and the county permits its unincorporated land
  own('Bartow County', 'https://www.bartowcountyga.gov/departments/community_development/building_inspections/index.php'),
  own('Cherokee County', 'https://www.cherokeecountyga.gov/dsc/building-permits-and-inspections/'),
  own('Cobb County', 'https://www.cobbcounty.gov/community-development/building-division/residential-building-permitting'),
  own('DeKalb County', 'https://dekalbcountyga.gov/departments/planning-and-sustainability/permits-plan-review-and-inspections'),
  own('Douglas County', 'https://www.douglascountyga.gov/224/Building-Permits-Inspections'),
  own('Forsyth County', 'https://www.forsythco.com/government/departments/building-licensing/'),
  own('Gilmer County', 'https://gilmercounty-ga.gov/planning-zoning/'),
  own('Gwinnett County', 'https://www.gwinnettcounty.com/government/departments/planning-development/building-services/building-permits-issued'),
  own('Henry County', 'https://www.henrycountyga.gov/building-plan-review-department'),
  own('Paulding County', 'https://www.paulding.gov/105/Building-Permitting-Division'),
  own('Peach County', 'https://peachcounty.gov/chief-marshal/chief-county-marshals-office-documents/'),
  own('Rockdale County', 'https://www.rockdalecountyga.gov/permits/'),
  own('Spalding County', 'https://www.spaldingcounty.com/business/building-permits'),
]);
