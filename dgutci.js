// dgutci.js - UTCI (Universal Thermal Climate Index) and SolarCal for SiteLaser.
//
// Ported from pythermalcomfort 2.10.0 (MIT licence, (c) 2019- Federico Tartarini, Stefano Schiavon,
// Center for the Built Environment, UC Berkeley; https://github.com/CenterForTheBuiltEnvironment/pythermalcomfort):
//   - pythermalcomfort/models/utci.py       : utciPoly() is the 6th-order polynomial copied term by term
//                                              (Brode et al. 2012, Int J Biometeorol 56:481-494), es() = its `exponential()`
//   - pythermalcomfort/models/solar_gain.py : solarGain() (SolarCal, ASHRAE 55-2020 Appendix C), same tables
// MIT licence: permission is granted, free of charge, to use, copy, modify and distribute this software provided the
// copyright notice and this permission notice are included in all copies. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY
// OF ANY KIND.
// Parity with the Python package was checked on 12+ input sets (max difference <= 0.1 C, see the build report).
//
// SiteLaser additions (not in pythermalcomfort): clear-sky direct beam (Meinel: DNI = 1353 * 0.7^(AM^0.678), Kasten-Young
// air mass), orientation-averaged delta-MRT, category table with SiteLaser colours.

const RAD = Math.PI / 180;

// ---- UTCI ---------------------------------------------------------------------------------------------
// saturation vapour pressure [hPa] (pythermalcomfort `exponential`)
export function es(tdb) {
  const g = [-2836.5744, -6028.076559, 19.54263612, -0.02737830188, 0.000016261698, 7.0229056 * 10 ** -10, -1.8680009 * 10 ** -13];
  const tk = tdb + 273.15;
  let e = 2.7150305 * Math.log1p(tk);
  g.forEach((c, i) => { e += c * Math.pow(tk, i - 2); });
  return Math.exp(e) * 0.01;
}

// raw polynomial: tdb [C], v 10 m wind [m/s], delta_t_tr = tr - tdb [K], pa vapour pressure [kPa]
export function utciPoly(tdb, v, delta_t_tr, pa) {
  return (
    tdb
    + 0.607562052
    + (-0.0227712343) * tdb
    + (8.06470249 * (10 ** (-4))) * tdb * tdb
    + (-1.54271372 * (10 ** (-4))) * tdb * tdb * tdb
    + (-3.24651735 * (10 ** (-6))) * tdb * tdb * tdb * tdb
    + (7.32602852 * (10 ** (-8))) * tdb * tdb * tdb * tdb * tdb
    + (1.35959073 * (10 ** (-9))) * tdb * tdb * tdb * tdb * tdb * tdb
    + (-2.25836520) * v
    + 0.0880326035 * tdb * v
    + 0.00216844454 * tdb * tdb * v
    + (-1.53347087 * (10 ** (-5))) * tdb * tdb * tdb * v
    + (-5.72983704 * (10 ** (-7))) * tdb * tdb * tdb * tdb * v
    + (-2.55090145 * (10 ** (-9))) * tdb * tdb * tdb * tdb * tdb * v
    + (-0.751269505) * v * v
    + (-0.00408350271) * tdb * v * v
    + (-5.21670675 * (10 ** (-5))) * tdb * tdb * v * v
    + (1.94544667 * (10 ** (-6))) * tdb * tdb * tdb * v * v
    + (1.14099531 * (10 ** (-8))) * tdb * tdb * tdb * tdb * v * v
    + 0.158137256 * v * v * v
    + (-6.57263143 * (10 ** (-5))) * tdb * v * v * v
    + (2.22697524 * (10 ** (-7))) * tdb * tdb * v * v * v
    + (-4.16117031 * (10 ** (-8))) * tdb * tdb * tdb * v * v * v
    + (-0.0127762753) * v * v * v * v
    + (9.66891875 * (10 ** (-6))) * tdb * v * v * v * v
    + (2.52785852 * (10 ** (-9))) * tdb * tdb * v * v * v * v
    + (4.56306672 * (10 ** (-4))) * v * v * v * v * v
    + (-1.74202546 * (10 ** (-7))) * tdb * v * v * v * v * v
    + (-5.91491269 * (10 ** (-6))) * v * v * v * v * v * v
    + 0.398374029 * delta_t_tr
    + (1.83945314 * (10 ** (-4))) * tdb * delta_t_tr
    + (-1.73754510 * (10 ** (-4))) * tdb * tdb * delta_t_tr
    + (-7.60781159 * (10 ** (-7))) * tdb * tdb * tdb * delta_t_tr
    + (3.77830287 * (10 ** (-8))) * tdb * tdb * tdb * tdb * delta_t_tr
    + (5.43079673 * (10 ** (-10))) * tdb * tdb * tdb * tdb * tdb * delta_t_tr
    + (-0.0200518269) * v * delta_t_tr
    + (8.92859837 * (10 ** (-4))) * tdb * v * delta_t_tr
    + (3.45433048 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr
    + (-3.77925774 * (10 ** (-7))) * tdb * tdb * tdb * v * delta_t_tr
    + (-1.69699377 * (10 ** (-9))) * tdb * tdb * tdb * tdb * v * delta_t_tr
    + (1.69992415 * (10 ** (-4))) * v * v * delta_t_tr
    + (-4.99204314 * (10 ** (-5))) * tdb * v * v * delta_t_tr
    + (2.47417178 * (10 ** (-7))) * tdb * tdb * v * v * delta_t_tr
    + (1.07596466 * (10 ** (-8))) * tdb * tdb * tdb * v * v * delta_t_tr
    + (8.49242932 * (10 ** (-5))) * v * v * v * delta_t_tr
    + (1.35191328 * (10 ** (-6))) * tdb * v * v * v * delta_t_tr
    + (-6.21531254 * (10 ** (-9))) * tdb * tdb * v * v * v * delta_t_tr
    + (-4.99410301 * (10 ** (-6))) * v * v * v * v * delta_t_tr
    + (-1.89489258 * (10 ** (-8))) * tdb * v * v * v * v * delta_t_tr
    + (8.15300114 * (10 ** (-8))) * v * v * v * v * v * delta_t_tr
    + (7.55043090 * (10 ** (-4))) * delta_t_tr * delta_t_tr
    + (-5.65095215 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr
    + (-4.52166564 * (10 ** (-7))) * tdb * tdb * delta_t_tr * delta_t_tr
    + (2.46688878 * (10 ** (-8))) * tdb * tdb * tdb * delta_t_tr * delta_t_tr
    + (2.42674348 * (10 ** (-10))) * tdb * tdb * tdb * tdb * delta_t_tr * delta_t_tr
    + (1.54547250 * (10 ** (-4))) * v * delta_t_tr * delta_t_tr
    + (5.24110970 * (10 ** (-6))) * tdb * v * delta_t_tr * delta_t_tr
    + (-8.75874982 * (10 ** (-8))) * tdb * tdb * v * delta_t_tr * delta_t_tr
    + (-1.50743064 * (10 ** (-9))) * tdb * tdb * tdb * v * delta_t_tr * delta_t_tr
    + (-1.56236307 * (10 ** (-5))) * v * v * delta_t_tr * delta_t_tr
    + (-1.33895614 * (10 ** (-7))) * tdb * v * v * delta_t_tr * delta_t_tr
    + (2.49709824 * (10 ** (-9))) * tdb * tdb * v * v * delta_t_tr * delta_t_tr
    + (6.51711721 * (10 ** (-7))) * v * v * v * delta_t_tr * delta_t_tr
    + (1.94960053 * (10 ** (-9))) * tdb * v * v * v * delta_t_tr * delta_t_tr
    + (-1.00361113 * (10 ** (-8))) * v * v * v * v * delta_t_tr * delta_t_tr
    + (-1.21206673 * (10 ** (-5))) * delta_t_tr * delta_t_tr * delta_t_tr
    + (-2.18203660 * (10 ** (-7))) * tdb * delta_t_tr * delta_t_tr * delta_t_tr
    + (7.51269482 * (10 ** (-9))) * tdb * tdb * delta_t_tr * delta_t_tr * delta_t_tr
    + (9.79063848 * (10 ** (-11)))
    * tdb
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.25006734 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (-1.81584736 * (10 ** (-9))) * tdb * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (-3.52197671 * (10 ** (-10)))
    * tdb
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-3.36514630 * (10 ** (-8))) * v * v * delta_t_tr * delta_t_tr * delta_t_tr
    + (1.35908359 * (10 ** (-10)))
    * tdb
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.17032620 * (10 ** (-10)))
    * v
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-1.30369025 * (10 ** (-9)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.13908461 * (10 ** (-10)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (9.22652254 * (10 ** (-12)))
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-5.08220384 * (10 ** (-9)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-2.24730961 * (10 ** (-11)))
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.17139133 * (10 ** (-10)))
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (6.62154879 * (10 ** (-10)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (4.03863260 * (10 ** (-13)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (1.95087203 * (10 ** (-12)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + (-4.73602469 * (10 ** (-12)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    + 5.12733497 * pa
    + (-0.312788561) * tdb * pa
    + (-0.0196701861) * tdb * tdb * pa
    + (9.99690870 * (10 ** (-4))) * tdb * tdb * tdb * pa
    + (9.51738512 * (10 ** (-6))) * tdb * tdb * tdb * tdb * pa
    + (-4.66426341 * (10 ** (-7))) * tdb * tdb * tdb * tdb * tdb * pa
    + 0.548050612 * v * pa
    + (-0.00330552823) * tdb * v * pa
    + (-0.00164119440) * tdb * tdb * v * pa
    + (-5.16670694 * (10 ** (-6))) * tdb * tdb * tdb * v * pa
    + (9.52692432 * (10 ** (-7))) * tdb * tdb * tdb * tdb * v * pa
    + (-0.0429223622) * v * v * pa
    + 0.00500845667 * tdb * v * v * pa
    + (1.00601257 * (10 ** (-6))) * tdb * tdb * v * v * pa
    + (-1.81748644 * (10 ** (-6))) * tdb * tdb * tdb * v * v * pa
    + (-1.25813502 * (10 ** (-3))) * v * v * v * pa
    + (-1.79330391 * (10 ** (-4))) * tdb * v * v * v * pa
    + (2.34994441 * (10 ** (-6))) * tdb * tdb * v * v * v * pa
    + (1.29735808 * (10 ** (-4))) * v * v * v * v * pa
    + (1.29064870 * (10 ** (-6))) * tdb * v * v * v * v * pa
    + (-2.28558686 * (10 ** (-6))) * v * v * v * v * v * pa
    + (-0.0369476348) * delta_t_tr * pa
    + 0.00162325322 * tdb * delta_t_tr * pa
    + (-3.14279680 * (10 ** (-5))) * tdb * tdb * delta_t_tr * pa
    + (2.59835559 * (10 ** (-6))) * tdb * tdb * tdb * delta_t_tr * pa
    + (-4.77136523 * (10 ** (-8))) * tdb * tdb * tdb * tdb * delta_t_tr * pa
    + (8.64203390 * (10 ** (-3))) * v * delta_t_tr * pa
    + (-6.87405181 * (10 ** (-4))) * tdb * v * delta_t_tr * pa
    + (-9.13863872 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr * pa
    + (5.15916806 * (10 ** (-7))) * tdb * tdb * tdb * v * delta_t_tr * pa
    + (-3.59217476 * (10 ** (-5))) * v * v * delta_t_tr * pa
    + (3.28696511 * (10 ** (-5))) * tdb * v * v * delta_t_tr * pa
    + (-7.10542454 * (10 ** (-7))) * tdb * tdb * v * v * delta_t_tr * pa
    + (-1.24382300 * (10 ** (-5))) * v * v * v * delta_t_tr * pa
    + (-7.38584400 * (10 ** (-9))) * tdb * v * v * v * delta_t_tr * pa
    + (2.20609296 * (10 ** (-7))) * v * v * v * v * delta_t_tr * pa
    + (-7.32469180 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa
    + (-1.87381964 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr * pa
    + (4.80925239 * (10 ** (-6))) * tdb * tdb * delta_t_tr * delta_t_tr * pa
    + (-8.75492040 * (10 ** (-8))) * tdb * tdb * tdb * delta_t_tr * delta_t_tr * pa
    + (2.77862930 * (10 ** (-5))) * v * delta_t_tr * delta_t_tr * pa
    + (-5.06004592 * (10 ** (-6))) * tdb * v * delta_t_tr * delta_t_tr * pa
    + (1.14325367 * (10 ** (-7))) * tdb * tdb * v * delta_t_tr * delta_t_tr * pa
    + (2.53016723 * (10 ** (-6))) * v * v * delta_t_tr * delta_t_tr * pa
    + (-1.72857035 * (10 ** (-8))) * tdb * v * v * delta_t_tr * delta_t_tr * pa
    + (-3.95079398 * (10 ** (-8))) * v * v * v * delta_t_tr * delta_t_tr * pa
    + (-3.59413173 * (10 ** (-7))) * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (7.04388046 * (10 ** (-7))) * tdb * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (-1.89309167 * (10 ** (-8)))
    * tdb
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-4.79768731 * (10 ** (-7))) * v * delta_t_tr * delta_t_tr * delta_t_tr * pa
    + (7.96079978 * (10 ** (-9)))
    * tdb
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (1.62897058 * (10 ** (-9)))
    * v
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (3.94367674 * (10 ** (-8)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-1.18566247 * (10 ** (-9)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (3.34678041 * (10 ** (-10)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-1.15606447 * (10 ** (-10)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    + (-2.80626406) * pa * pa
    + 0.548712484 * tdb * pa * pa
    + (-0.00399428410) * tdb * tdb * pa * pa
    + (-9.54009191 * (10 ** (-4))) * tdb * tdb * tdb * pa * pa
    + (1.93090978 * (10 ** (-5))) * tdb * tdb * tdb * tdb * pa * pa
    + (-0.308806365) * v * pa * pa
    + 0.0116952364 * tdb * v * pa * pa
    + (4.95271903 * (10 ** (-4))) * tdb * tdb * v * pa * pa
    + (-1.90710882 * (10 ** (-5))) * tdb * tdb * tdb * v * pa * pa
    + 0.00210787756 * v * v * pa * pa
    + (-6.98445738 * (10 ** (-4))) * tdb * v * v * pa * pa
    + (2.30109073 * (10 ** (-5))) * tdb * tdb * v * v * pa * pa
    + (4.17856590 * (10 ** (-4))) * v * v * v * pa * pa
    + (-1.27043871 * (10 ** (-5))) * tdb * v * v * v * pa * pa
    + (-3.04620472 * (10 ** (-6))) * v * v * v * v * pa * pa
    + 0.0514507424 * delta_t_tr * pa * pa
    + (-0.00432510997) * tdb * delta_t_tr * pa * pa
    + (8.99281156 * (10 ** (-5))) * tdb * tdb * delta_t_tr * pa * pa
    + (-7.14663943 * (10 ** (-7))) * tdb * tdb * tdb * delta_t_tr * pa * pa
    + (-2.66016305 * (10 ** (-4))) * v * delta_t_tr * pa * pa
    + (2.63789586 * (10 ** (-4))) * tdb * v * delta_t_tr * pa * pa
    + (-7.01199003 * (10 ** (-6))) * tdb * tdb * v * delta_t_tr * pa * pa
    + (-1.06823306 * (10 ** (-4))) * v * v * delta_t_tr * pa * pa
    + (3.61341136 * (10 ** (-6))) * tdb * v * v * delta_t_tr * pa * pa
    + (2.29748967 * (10 ** (-7))) * v * v * v * delta_t_tr * pa * pa
    + (3.04788893 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa * pa
    + (-6.42070836 * (10 ** (-5))) * tdb * delta_t_tr * delta_t_tr * pa * pa
    + (1.16257971 * (10 ** (-6))) * tdb * tdb * delta_t_tr * delta_t_tr * pa * pa
    + (7.68023384 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * pa * pa
    + (-5.47446896 * (10 ** (-7))) * tdb * v * delta_t_tr * delta_t_tr * pa * pa
    + (-3.59937910 * (10 ** (-8))) * v * v * delta_t_tr * delta_t_tr * pa * pa
    + (-4.36497725 * (10 ** (-6))) * delta_t_tr * delta_t_tr * delta_t_tr * pa * pa
    + (1.68737969 * (10 ** (-7)))
    * tdb
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (2.67489271 * (10 ** (-8)))
    * v
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (3.23926897 * (10 ** (-9)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    + (-0.0353874123) * pa * pa * pa
    + (-0.221201190) * tdb * pa * pa * pa
    + 0.0155126038 * tdb * tdb * pa * pa * pa
    + (-2.63917279 * (10 ** (-4))) * tdb * tdb * tdb * pa * pa * pa
    + 0.0453433455 * v * pa * pa * pa
    + (-0.00432943862) * tdb * v * pa * pa * pa
    + (1.45389826 * (10 ** (-4))) * tdb * tdb * v * pa * pa * pa
    + (2.17508610 * (10 ** (-4))) * v * v * pa * pa * pa
    + (-6.66724702 * (10 ** (-5))) * tdb * v * v * pa * pa * pa
    + (3.33217140 * (10 ** (-5))) * v * v * v * pa * pa * pa
    + (-0.00226921615) * delta_t_tr * pa * pa * pa
    + (3.80261982 * (10 ** (-4))) * tdb * delta_t_tr * pa * pa * pa
    + (-5.45314314 * (10 ** (-9))) * tdb * tdb * delta_t_tr * pa * pa * pa
    + (-7.96355448 * (10 ** (-4))) * v * delta_t_tr * pa * pa * pa
    + (2.53458034 * (10 ** (-5))) * tdb * v * delta_t_tr * pa * pa * pa
    + (-6.31223658 * (10 ** (-6))) * v * v * delta_t_tr * pa * pa * pa
    + (3.02122035 * (10 ** (-4))) * delta_t_tr * delta_t_tr * pa * pa * pa
    + (-4.77403547 * (10 ** (-6))) * tdb * delta_t_tr * delta_t_tr * pa * pa * pa
    + (1.73825715 * (10 ** (-6))) * v * delta_t_tr * delta_t_tr * pa * pa * pa
    + (-4.09087898 * (10 ** (-7)))
    * delta_t_tr
    * delta_t_tr
    * delta_t_tr
    * pa
    * pa
    * pa
    + 0.614155345 * pa * pa * pa * pa
    + (-0.0616755931) * tdb * pa * pa * pa * pa
    + 0.00133374846 * tdb * tdb * pa * pa * pa * pa
    + 0.00355375387 * v * pa * pa * pa * pa
    + (-5.13027851 * (10 ** (-4))) * tdb * v * pa * pa * pa * pa
    + (1.02449757 * (10 ** (-4))) * v * v * pa * pa * pa * pa
    + (-0.00148526421) * delta_t_tr * pa * pa * pa * pa
    + (-4.11469183 * (10 ** (-5))) * tdb * delta_t_tr * pa * pa * pa * pa
    + (-6.80434415 * (10 ** (-6))) * v * delta_t_tr * pa * pa * pa * pa
    + (-9.77675906 * (10 ** (-6))) * delta_t_tr * delta_t_tr * pa * pa * pa * pa
    + 0.0882773108 * pa * pa * pa * pa * pa
    + (-0.00301859306) * tdb * pa * pa * pa * pa * pa
    + 0.00104452989 * v * pa * pa * pa * pa * pa
    + (2.47090539 * (10 ** (-4))) * delta_t_tr * pa * pa * pa * pa * pa
    + 0.00148348065 * pa * pa * pa * pa * pa * pa
  );
}

// UTCI [C], unrounded; NaN outside the applicability limits (-50..50, -30..70 for tr - tdb, 0.5..17 m/s)
export function utci(tdb, tr, v, rh, limit = true) {
  const pa = es(tdb) * (rh / 100) / 10;
  const out = utciPoly(tdb, v, tr - tdb, pa);
  if (limit && !(tdb >= -50 && tdb <= 50 && tr - tdb >= -30 && tr - tdb <= 70 && v >= 0.5 && v <= 17)) return NaN;
  return out;
}
// wind is clamped to the validity range 0.5-17 m/s (EPW 10 m speed)
export const clampWind = v => Math.min(17, Math.max(0.5, v));

// ---- SolarCal (pythermalcomfort solar_gain) -------------------------------------------------------------
const FP_STAND = [
  [0.35, 0.35, 0.314, 0.258, 0.206, 0.144, 0.082], [0.342, 0.342, 0.31, 0.252, 0.2, 0.14, 0.082],
  [0.33, 0.33, 0.3, 0.244, 0.19, 0.132, 0.082], [0.31, 0.31, 0.275, 0.228, 0.175, 0.124, 0.082],
  [0.283, 0.283, 0.251, 0.208, 0.16, 0.114, 0.082], [0.252, 0.252, 0.228, 0.188, 0.15, 0.108, 0.082],
  [0.23, 0.23, 0.214, 0.18, 0.148, 0.108, 0.082], [0.242, 0.242, 0.222, 0.18, 0.153, 0.112, 0.082],
  [0.274, 0.274, 0.245, 0.203, 0.165, 0.116, 0.082], [0.304, 0.304, 0.27, 0.22, 0.174, 0.121, 0.082],
  [0.328, 0.328, 0.29, 0.234, 0.183, 0.125, 0.082], [0.344, 0.344, 0.304, 0.244, 0.19, 0.128, 0.082],
  [0.347, 0.347, 0.308, 0.246, 0.191, 0.128, 0.082]
];
const FP_SEAT = [
  [0.29, 0.324, 0.305, 0.303, 0.262, 0.224, 0.177], [0.292, 0.328, 0.294, 0.288, 0.268, 0.227, 0.177],
  [0.288, 0.332, 0.298, 0.29, 0.264, 0.222, 0.177], [0.274, 0.326, 0.294, 0.289, 0.252, 0.214, 0.177],
  [0.254, 0.308, 0.28, 0.276, 0.241, 0.202, 0.177], [0.23, 0.282, 0.262, 0.26, 0.233, 0.193, 0.177],
  [0.216, 0.26, 0.248, 0.244, 0.22, 0.186, 0.177], [0.234, 0.258, 0.236, 0.227, 0.208, 0.18, 0.177],
  [0.262, 0.26, 0.224, 0.208, 0.196, 0.176, 0.177], [0.28, 0.26, 0.21, 0.192, 0.184, 0.17, 0.177],
  [0.298, 0.256, 0.194, 0.174, 0.168, 0.168, 0.177], [0.306, 0.25, 0.18, 0.156, 0.156, 0.166, 0.177],
  [0.3, 0.24, 0.168, 0.152, 0.152, 0.164, 0.177]
];
const ALT_R = [0, 15, 30, 45, 60, 75, 90], AZ_R = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180];
const findSpan = (arr, x) => { for (let i = 0; i < arr.length - 1; i++) if (arr[i + 1] >= x && x >= arr[i]) return i; return -1; };

// returns { erf, deltaMrt } (unrounded). sharp = angle between sun azimuth and the person's front, 0-180 deg.
// diffRatio: diffuse = diffRatio * direct (pythermalcomfort fixes 0.2; SiteLaser passes 0.1, see report).
export function solarGain(alt, sharp, dir, trans = 1, fsvv = 1, fbes = 1, asw = 0.7, posture = "standing", floorRefl = 0.6, diffRatio = 0.2) {
  const iDiff = diffRatio * dir, fpT = posture === "seated" ? FP_SEAT : FP_STAND;
  const ai = findSpan(ALT_R, alt), zi = findSpan(AZ_R, sharp);
  const fp11 = fpT[zi][ai], fp12 = fpT[zi][ai + 1], fp21 = fpT[zi + 1][ai], fp22 = fpT[zi + 1][ai + 1];
  const az1 = AZ_R[zi], az2 = AZ_R[zi + 1], a1 = ALT_R[ai], a2 = ALT_R[ai + 1];
  let fp = fp11 * (az2 - sharp) * (a2 - alt) + fp21 * (sharp - az1) * (a2 - alt) + fp12 * (az2 - sharp) * (alt - a1) + fp22 * (sharp - az1) * (alt - a1);
  fp /= (az2 - az1) * (a2 - a1);
  const fEff = posture === "seated" ? 0.696 : 0.725;
  const eDiff = fEff * fsvv * 0.5 * trans * iDiff;
  const eDirect = fEff * fp * trans * fbes * dir;
  const eRefl = fEff * fsvv * 0.5 * trans * (dir * Math.sin(alt * 0.0174532925) + iDiff) * floorRefl;
  const erf = (eDiff + eDirect + eRefl) * (asw / 0.95);
  return { erf, deltaMrt: erf / (6 * fEff) };
}

// ---- SiteLaser clear-sky model ---------------------------------------------------------------------------
// Meinel clear-sky direct normal irradiance [W/m2] from sun altitude [rad]; 0 below 2 deg.
export function clearSkyDni(altRad) {
  const a = altRad / RAD;
  if (a < 2) return 0;
  const am = 1 / (Math.sin(altRad) + 0.50572 * Math.pow(6.07995 + a, -1.6364));   // Kasten & Young 1989
  return 1353 * Math.pow(0.7, Math.pow(am, 0.678));
}
// delta-MRT of a standing person in full sun, averaged over body orientation (SHARP 0..180 every 15 deg, trapezoid).
// Outdoor assumptions: open sky (f_svv = 1), whole body sunlit (f_bes = 1), ground reflectance 0.25, diffuse = 0.1 * direct.
export const SOLAR_OPTS = { floorRefl: 0.25, diffRatio: 0.1 };
export function deltaMrtSun(altRad, o = SOLAR_OPTS) {
  const dni = clearSkyDni(altRad);
  if (dni <= 0) return { dMrt: 0, dni: 0 };
  const alt = Math.min(90, altRad / RAD);
  let s = 0;
  AZ_R.forEach((sh, i) => { const w = i === 0 || i === AZ_R.length - 1 ? .5 : 1; s += w * solarGain(alt, sh, dni, 1, 1, 1, 0.7, "standing", o.floorRefl, o.diffRatio).deltaMrt; });
  return { dMrt: s / (AZ_R.length - 1), dni };
}
// shade: tr = tdb. sun: tr = tdb + delta-MRT(sun altitude). Returns UTCI [C] (NaN if outside the limits).
export function utciShade(ta, rh, ws) { return utci(ta, ta, clampWind(ws), rh); }
export function utciSun(ta, rh, ws, altRad, o) { const d = deltaMrtSun(altRad, o).dMrt; return utci(ta, ta + d, clampWind(ws), rh); }

// ---- categories (Brode et al. 2012 bounds; colours = SiteLaser climate palette) -----------------------------
export const UTCI_CATS = [
  { max: -40, ko: "극심한 한랭", hex: "#313695" }, { max: -27, ko: "매우 강한 한랭", hex: "#4575B4" },
  { max: -13, ko: "강한 한랭", hex: "#2C7BB6" }, { max: 0, ko: "중간 한랭", hex: "#6BAED6" },
  { max: 9, ko: "약한 한랭", hex: "#9ECAE1", edge: "#4575B4" }, { max: 26, ko: "열스트레스 없음", hex: "#66C2A5" },
  { max: 32, ko: "중간 고온", hex: "#F4C430" }, { max: 38, ko: "강한 고온", hex: "#F06529" },
  { max: 46, ko: "매우 강한 고온", hex: "#D7191C" }, { max: Infinity, ko: "극심한 고온", hex: "#7F000D" }
];
export const UTCI_RANGE = ["< -40", "-40 ~ -27", "-27 ~ -13", "-13 ~ 0", "0 ~ 9", "9 ~ 26", "26 ~ 32", "32 ~ 38", "38 ~ 46", "> 46"];
// same bounds as pythermalcomfort's stress_category mapping: value <= bound -> that class
export const utciCat = t => { const i = UTCI_CATS.findIndex(c => t <= c.max); return i < 0 ? 9 : i; };
