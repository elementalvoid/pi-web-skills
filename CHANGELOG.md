# Changelog

## 0.1.0 (2026-10-25)


### Features

* add managed-directory and temp-path containment checks ([b80599f](https://github.com/elementalvoid/pi-web-skills/commit/b80599f0747fd93ee21caa10b937cb031e16b8fb))
* add read-only Check for updates ([8c08019](https://github.com/elementalvoid/pi-web-skills/commit/8c08019568c3cdb3e3015209b0f1db7e1479e5e9))
* add the machine-wide Skills workspace panel ([0bde66d](https://github.com/elementalvoid/pi-web-skills/commit/0bde66da3fed86c776dd93fc1ea2049356fa0662))
* install selected skills and write one lock entry each ([62fb61f](https://github.com/elementalvoid/pi-web-skills/commit/62fb61fbfd2f6e63f0e50d232f6c1b9d9be23661))
* list present skills as managed, unmanaged, or broken ([c5a54a3](https://github.com/elementalvoid/pi-web-skills/commit/c5a54a3175582fb9703355ee12c8d56711bb37ac))
* make the compact skill row the disclosure control ([5da23e9](https://github.com/elementalvoid/pi-web-skills/commit/5da23e9ae6de5c763e5d0b1096bbdcfa890c5b81))
* match a requested skill name against lock keys and folders ([7f9433f](https://github.com/elementalvoid/pi-web-skills/commit/7f9433fd55a2819f9ecda72d38854d4e7f5db8f4))
* read, atomically write, and serialize the standard global lockfile ([f621674](https://github.com/elementalvoid/pi-web-skills/commit/f6216742bfe11cd9c0615150d1d67729ca8d3239))
* redesign the Skills panel and add Open Skills action ([df247bd](https://github.com/elementalvoid/pi-web-skills/commit/df247bd08b329182e6565d02bf3677b554069436))
* remove managed installs and clean up broken entries ([9827739](https://github.com/elementalvoid/pi-web-skills/commit/98277391fc99097e869039c4369b0ca6c91b3a22))
* report machine skill paths and status from one operation ([76c7ea0](https://github.com/elementalvoid/pi-web-skills/commit/76c7ea01c778a354c86f5320ea779def81a725d2))
* resolve add sources and stream skill candidates ([92fd100](https://github.com/elementalvoid/pi-web-skills/commit/92fd10056a4987b7ce4aabb9d9d3143f763a9fdb))
* search skills.sh and start Add from a result ([11771da](https://github.com/elementalvoid/pi-web-skills/commit/11771da32567d8027222f08bea7e5b936e6aaa93))
* serve the status operation through the server plugin peer ([6b868dd](https://github.com/elementalvoid/pi-web-skills/commit/6b868dd647e9842cfc7de82ff6c220f8343bd353))
* update managed installs at the locked ref ([94680ee](https://github.com/elementalvoid/pi-web-skills/commit/94680ee75bc06bceee1ae3a208bb615bc911e3eb))
* vendor the pinned upstream skills modules with provenance ([e0c203c](https://github.com/elementalvoid/pi-web-skills/commit/e0c203ce33b8a7c211aad3d64c57bee0f2365fdb))


### Bug Fixes

* abort a pending add open and disable install until ticket 05 ([a93f851](https://github.com/elementalvoid/pi-web-skills/commit/a93f851971bd35d28826c0dea8a3592253318888))
* bound add candidate frames and match the present target ([3ab52b7](https://github.com/elementalvoid/pi-web-skills/commit/3ab52b75e670da25eed81a15976780b17593da81))
* close add channels and harden update against broken entries ([581c527](https://github.com/elementalvoid/pi-web-skills/commit/581c527dd88c3c09ca3145d9f42ed787f49cbc6d))
* commit lock mutations only on success and key them by real path ([117735a](https://github.com/elementalvoid/pi-web-skills/commit/117735afc5e2cd938e1994314d6930ad74e30255))
* give operation errors optional JSON details and a shared result type ([78cc9db](https://github.com/elementalvoid/pi-web-skills/commit/78cc9db28d40a89cf04f19bb2c65e4bb767e9152))
* harden the skills list read model ([5fc6393](https://github.com/elementalvoid/pi-web-skills/commit/5fc63939a6fe59ff8997b37c44ec3bdea1e8b964))
* install by source path and keep failed installs terminal ([3878a62](https://github.com/elementalvoid/pi-web-skills/commit/3878a62305eb12c24021f2949da92875f04a6fd2))
* keep remove results structured and guard list refreshes ([7a02f32](https://github.com/elementalvoid/pi-web-skills/commit/7a02f32d944815e831768fd0fa2d60dd28a9eee8))
* keep updated skills and the reload reminder when Update is cancelled ([7598557](https://github.com/elementalvoid/pi-web-skills/commit/7598557823cf857c7e05d39cc581eed41a4fd116))
* make search re-render, handoff per workspace, and time out bodies ([67edd18](https://github.com/elementalvoid/pi-web-skills/commit/67edd181e8a27f363910a0770682d4b451448472))
* report a malformed lock as unreadable in status ([14f6901](https://github.com/elementalvoid/pi-web-skills/commit/14f6901d56664a6b2814e03aee8ee2f354deb1f0))
* resolve symlinks before containment checks ([6277cf1](https://github.com/elementalvoid/pi-web-skills/commit/6277cf1f8a59490b07d87a92cf7f9af469a378ed))
