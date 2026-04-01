import type { APIRoute } from 'astro';
import { getSiteStats } from '../utils/stats';

export const GET: APIRoute = async () => {
  const s = await getSiteStats();

  const roomTypeLines = Object.entries(s.roomsByType)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `- ${count}+ ${type.toLowerCase()}s built`);

  const body = `# Sunshine on a Ranney Day

> 501(c)(3) nonprofit creating life-changing home makeovers for children with special needs and life-altering illnesses in the greater Atlanta area. We design and build custom dream bedrooms, wheelchair-accessible bathrooms, and in-home therapy rooms — all at no cost to families. EIN: 45-4773997. Operating since 2012. Based in Roswell, Georgia.

We are a nonprofit that partners with professional designers, contractors, and suppliers to transform the homes of children facing serious medical challenges. Our work gives families functional, beautiful spaces that support their child's independence, therapy, and joy.

## Key Facts
- ${s.totalKids}+ children served since 2012
- ${s.totalRooms}+ rooms completed (bedrooms, bathrooms, therapy rooms)
${roomTypeLines.join('\n')}
- ${s.livesImpacted.toLocaleString()}+ children impacted through community projects
- Donated materials and labor from professional partners

## Programs
- Dream Bedrooms: Custom-designed bedrooms tailored to each child's interests, medical equipment needs, and sensory preferences
- Accessible Bathrooms: Wheelchair-accessible bathroom renovations including roll-in showers, grab bars, widened doorways, and adjustable fixtures
- Therapy Rooms: In-home therapy spaces for physical, occupational, and speech therapy
- Community Projects: Large-scale playground builds and facility renovations at schools and nonprofits serving children with special needs

## Pages
- [Home](https://sunshineonaranneyday.com/): Mission overview, featured kids, impact stats, partner logos
- [About — Our Story](https://sunshineonaranneyday.com/about/): How SOARD was founded by the Ranney family in 2012
- [About — Leadership](https://sunshineonaranneyday.com/about/leadership/): Board of directors and advisory board bios
- [About — Financials](https://sunshineonaranneyday.com/about/financials/): 990 filings, annual reports, GuideStar profile
- [Meet the Kids](https://sunshineonaranneyday.com/kids/): Profiles of every child we've served with photos and stories
- [Community Projects](https://sunshineonaranneyday.com/community/): School and facility renovation projects
- [Partners](https://sunshineonaranneyday.com/partners/): Companies and organizations that make our work possible
- [Donate](https://sunshineonaranneyday.com/donate/): Tax-deductible donations via Zeffy (0% platform fees)
- [Apply](https://sunshineonaranneyday.com/apply/): Families can apply for a home makeover
- [FAQs](https://sunshineonaranneyday.com/faq/): Common questions about donations, volunteering, and applications
- [Publicity](https://sunshineonaranneyday.com/publicity/): Media coverage and press mentions
- [Resources](https://sunshineonaranneyday.com/resources/): Helpful links for families of children with special needs
- [Guide: Accessible Home Design](https://sunshineonaranneyday.com/resources/accessible-home-design/): Comprehensive guide to wheelchair-accessible bathrooms, bedrooms, doorways, ramps, and funding
- [Guide: Sensory-Friendly Bedrooms](https://sunshineonaranneyday.com/resources/sensory-friendly-bedroom/): How to design bedrooms for children with autism and sensory processing differences
- [Guide: Therapy Room Design](https://sunshineonaranneyday.com/resources/therapy-room-design/): In-home therapy room equipment, layout, safety, and funding guide

## Contact
- Address: 250 Hembree Park Drive, Suite 106, Roswell GA 30076
- Phone: 770.990.2434
- Email: info@soardcharity.com
- Website: https://sunshineonaranneyday.com
- Facebook: https://www.facebook.com/sunshineonaranneyday
- Instagram: https://www.instagram.com/sunshineonaranneyday

## Related
- Sunny & Ranney retail store: https://www.sunnyandranney.com (profits fund the charity)
- Partly Sunny store: https://partlysunnystore.com/
- GuideStar profile: https://www.guidestar.org/profile/shared/2954b510-8c76-42e4-b589-7e826ca2cc47

## Optional
- [Full LLM context](https://sunshineonaranneyday.com/llms-full.txt): Comprehensive version with program details, kid profiles, and partner information
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
