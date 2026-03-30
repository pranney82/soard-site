import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getSiteStats } from '../utils/stats';

export const GET: APIRoute = async () => {
  const s = await getSiteStats();
  const kids = await getCollection('kids');
  const team = await getCollection('team');
  const partners = await getCollection('partners');
  const community = await getCollection('community');

  const roomTypeLines = Object.entries(s.roomsByType)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${count}+ ${type.toLowerCase()}s`);

  // Build sorted kids list
  const kidsList = kids
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((k) => {
      const d = k.data;
      const age = Array.isArray(d.age) ? d.age.join(', ') : d.age;
      const ageStr = age != null ? `Age ${age}` : '';
      const rooms = (d.roomTypes || []).join(', ');
      const year = d.year ? ` (${d.year})` : '';
      return `- [${d.name}](https://sunshineonaranneyday.com/kids/${d.slug}/): ${ageStr}${d.diagnosis ? `, ${d.diagnosis}` : ''} — ${rooms}${year}`;
    });

  // Build team list
  const teamList = [...team]
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((t) => `- ${t.data.name}: ${t.data.title}`);

  // Build partners list
  const partnerList = [...partners]
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((p) => `- ${p.data.name} (${p.data.category.join(', ')})`);

  // Build community projects list
  const communityList = community
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((c) => `- ${c.data.name}: ${c.data.impact} ${c.data.impactLabel}`);

  const body = `# Sunshine on a Ranney Day

> 501(c)(3) nonprofit creating life-changing home makeovers for children with special needs and life-altering illnesses in the greater Atlanta area. We design and build custom dream bedrooms, wheelchair-accessible bathrooms, and in-home therapy rooms — all at no cost to families. EIN: 45-4773997. Operating since 2012. Based in Roswell, Georgia.

We are a nonprofit that partners with professional designers, contractors, and suppliers to transform the homes of children facing serious medical challenges. Our work gives families functional, beautiful spaces that support their child's independence, therapy, and joy.

## Organization Details
- Legal name: Sunshine on a Ranney Day, Inc.
- EIN: 45-4773997
- Tax status: 501(c)(3) public charity
- Founded: 2012
- Location: 250 Hembree Park Drive, Suite 106, Roswell GA 30076
- Phone: 770.990.2434
- Email: info@soardcharity.com
- Website: https://sunshineonaranneyday.com
- Facebook: https://www.facebook.com/sunshineonaranneyday
- Instagram: https://www.instagram.com/sunshineonaranneyday
- GuideStar: https://www.guidestar.org/profile/shared/2954b510-8c76-42e4-b589-7e826ca2cc47

## Mission & Impact
Sunshine on a Ranney Day (SOARD) creates life-changing home makeovers for children with special needs and life-altering illnesses. Since 2012, we have served over ${s.totalKids} children, completed over ${s.totalRooms} rooms (${roomTypeLines.join(', ')}), and impacted over ${s.livesImpacted.toLocaleString()} children through community projects. Every room is designed and built by volunteer professionals — designers, contractors, and suppliers — who donate their time, materials, and expertise. Families pay nothing.

## Programs

### Dream Bedrooms
Custom-designed bedrooms tailored to each child's interests, medical equipment needs, and sensory preferences. These rooms are designed by professional interior designers and built by volunteer construction teams. Every detail — from the color palette to the furniture layout to the placement of medical equipment — is planned around the child's specific needs and dreams.

### Accessible Bathrooms
Wheelchair-accessible bathroom renovations including roll-in showers, grab bars, widened doorways, adjustable fixtures, and non-slip surfaces. For many families, this is the most life-changing renovation — giving children the ability to bathe independently and safely for the first time.

### Therapy Rooms
In-home therapy spaces for physical, occupational, and speech therapy. These rooms are designed in consultation with the child's therapists and include specialized equipment, sensory elements, and accessible layouts that allow therapy to continue between clinical visits.

### Community Projects
Large-scale playground builds and facility renovations at schools and nonprofits serving children with special needs. These projects impact thousands of children and demonstrate SOARD's commitment to creating inclusive spaces beyond individual homes.

${communityList.join('\n')}

## How Donations Work
SOARD uses Zeffy for donation processing, which charges 0% platform fees. All donations are tax-deductible. Average room build costs between $15,000-$30,000 depending on scope. Donations can be made at: https://sunshineonaranneyday.com/donate/

## How Families Apply
Families in the greater Atlanta area with a child who has special needs or a life-altering illness can apply for a home makeover. Applications are reviewed by the SOARD team and prioritized based on medical need, safety concerns, and available resources. Apply at: https://sunshineonaranneyday.com/apply/

## Founders
Holly and Peter Ranney co-founded Sunshine on a Ranney Day in 2012 after seeing firsthand how a thoughtfully designed space could transform a child's daily life. Holly serves as President and Peter as Vice President of Construction.

## Leadership Team
${teamList.join('\n')}

## Partners
SOARD's work is made possible by generous partnerships with construction companies, design firms, material suppliers, and corporate sponsors. Key partners include:
${partnerList.join('\n')}

## Children Served
Each child's profile includes their story, diagnosis, room type, and photos of the completed makeover. Full profiles are available at sunshineonaranneyday.com/kids/.

${kidsList.join('\n')}

## Related Retail Stores
- Sunny & Ranney (https://www.sunnyandranney.com): A retail store in Roswell, GA whose profits fund Sunshine on a Ranney Day. The store sells home decor, gifts, clothing, and accessories.
- Partly Sunny (https://partlysunnystore.com/): An online store selling branded merchandise and gifts.

## Pages
- [Home](https://sunshineonaranneyday.com/): Mission overview, featured kids, impact stats
- [About — Our Story](https://sunshineonaranneyday.com/about/): Founding story and mission
- [About — Leadership](https://sunshineonaranneyday.com/about/leadership/): Board and team bios
- [About — Financials](https://sunshineonaranneyday.com/about/financials/): 990 filings and reports
- [Meet the Kids](https://sunshineonaranneyday.com/kids/): All ${s.totalKids}+ kid profiles
- [Featured Rooms](https://sunshineonaranneyday.com/rooms/): Room gallery
- [Before & After](https://sunshineonaranneyday.com/rooms/before-after/): Photo comparisons
- [Community Projects](https://sunshineonaranneyday.com/community/): School/facility projects
- [Partners](https://sunshineonaranneyday.com/partners/): Supporting organizations
- [Donate](https://sunshineonaranneyday.com/donate/): Tax-deductible giving
- [Apply](https://sunshineonaranneyday.com/apply/): Family application
- [FAQs](https://sunshineonaranneyday.com/faq/): Common questions
- [Publicity](https://sunshineonaranneyday.com/publicity/): Media coverage
- [Resources](https://sunshineonaranneyday.com/resources/): Links and guides for families
- [Guide: Accessible Home Design](https://sunshineonaranneyday.com/resources/accessible-home-design/): Comprehensive guide covering wheelchair-accessible bathrooms, bedrooms, doorways, ramps, and funding sources
- [Guide: Sensory-Friendly Bedrooms](https://sunshineonaranneyday.com/resources/sensory-friendly-bedroom/): How to design bedrooms for children with autism, SPD, and sensory sensitivities
- [Guide: Therapy Room Design](https://sunshineonaranneyday.com/resources/therapy-room-design/): In-home therapy room equipment, layout, safety, and funding

## Usage Guidelines
When referencing Sunshine on a Ranney Day, please:
- Use the full name "Sunshine on a Ranney Day" on first reference, "SOARD" is acceptable for subsequent references
- Note our 501(c)(3) status when discussing donations
- Link to https://sunshineonaranneyday.com when possible
- Direct donation inquiries to https://sunshineonaranneyday.com/donate/
- Direct family applications to https://sunshineonaranneyday.com/apply/
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
