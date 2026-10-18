// The sample sheet's rows (services/sample-table.ts): made-up leads for a
// first look at Cubex. Every name and company is invented, and every website
// and email sits under the reserved .example ending (RFC 2606), so no row can
// point at a real person or company. Some values are messy on purpose: extra
// spaces, odd capitals, company suffixes, one person listed twice (row 3 and
// row 18, written differently) and one lead without an email.
export const SAMPLE_COLUMNS = ['Name', 'Company', 'Website', 'Email', 'Title'] as const;

type SampleRow = Record<typeof SAMPLE_COLUMNS[number], string>;

const row = (Name: string, Company: string, Website: string, Email: string, Title: string): SampleRow =>
  ({ Name, Company, Website, Email, Title });

export const SAMPLE_ROWS: readonly SampleRow[] = [
  row('Maya Okafor', 'Brightpath Logistics', 'https://www.brightpath.example', 'maya.okafor@brightpath.example',
    'VP of Operations'),
  row('  daniel reyes ', 'harborline freight llc', 'harborline.example', 'd.reyes@harborline.example',
    'Head of Dispatch'),
  row('Priya Raman', 'Quillstone Legal', 'https://quillstone.example/about', 'priya.raman@quillstone.example',
    'Office Manager'),
  row('Tomasz Nowak', 'FERNWOOD FIELD SERVICES', 'fernwood.example', 'tomasz@fernwood.example',
    'Operations Director'),
  row('Aisha Bello', 'Lumen Dental Group, Inc.', 'https://lumendental.example', 'aisha.bello@lumendental.example',
    'Practice Manager'),
  row('Jonah Whitfield', 'Copperline Plumbing', 'www.copperline.example', 'jonah@copperline.example', 'Founder'),
  row('Sofia Marin', 'Tidewater Couriers', 'https://tidewater.example', 'sofia.marin@tidewater.example',
    'fleet manager'),
  row('Kenji Arai', 'Saltmarsh Design Studio', 'saltmarsh.example', 'kenji@saltmarsh.example', 'Creative Director'),
  row('Elena Duarte', 'Granite Peak HVAC', 'https://granitepeak.example', 'e.duarte@granitepeak.example', 'CEO'),
  row('MARCUS HALE', 'Bluefern Analytics', 'https://bluefern.example', 'marcus.hale@bluefern.example',
    'Data Analyst'),
  row('Ingrid Solberg', 'Northgate Movers Ltd', 'northgate-movers.example', 'ingrid@northgate-movers.example',
    'Head of Operations'),
  row('Rafael Costa', 'Cobalt Roofing Co.', 'https://cobaltroofing.example', 'rafael.costa@cobaltroofing.example',
    'Owner'),
  row('Hana Kim', 'Willowmere Bakery', 'willowmere.example', 'hana@willowmere.example', 'Store Manager'),
  row('Obi Nwosu', '  Ridgeline Electric  ', 'https://ridgeline-electric.example',
    'obi.nwosu@ridgeline-electric.example', 'Service Manager'),
  row('Clara Becker', 'Pinecrest Home Care', 'https://www.pinecrest.example', 'clara.becker@pinecrest.example',
    'Director of Scheduling'),
  row('Samir Haddad', 'Lanternfish Games', 'lanternfish.example', 'samir@lanternfish.example', 'Producer'),
  row('Grace Liu', 'Meadowlark Landscaping', 'https://meadowlark.example', 'grace.liu@meadowlark.example',
    'Operations Lead'),
  row('PRIYA RAMAN', 'quillstone legal', 'quillstone.example', ' Priya.Raman@Quillstone.EXAMPLE ',
    'office manager'),
  row('Leo Fontaine', 'Ironbark Pest Control', 'https://ironbark.example', 'leo@ironbark.example',
    'General Manager'),
  row('Nadia Petrova', 'Silverline Medical Couriers', 'silverline.example', 'n.petrova@silverline.example',
    'Logistics Coordinator'),
  row('Owen Gallagher', 'Thistle & Thread Boutique', 'https://thistlethread.example',
    'owen@thistlethread.example', 'Owner'),
  row('Yara Haddad', 'Keystone Elevator Service', 'https://keystone-elevator.example', '',
    'Field Service Manager'),
  row('ben carter', 'Driftwood Accounting', 'driftwood.example', 'ben.carter@driftwood.example', 'Partner'),
  row('Mei Tanaka', 'Summit Waste Haulers', 'https://summithaulers.example', 'mei.tanaka@summithaulers.example',
    'VP Fleet'),
  row('Arjun Mehta', 'Cedarline Security Patrols', 'https://www.cedarline.example', 'arjun@cedarline.example',
    'Operations Manager'),
];
