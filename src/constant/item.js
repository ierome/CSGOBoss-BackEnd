
// Item Categories

export const CATEGORY_MELEE         = "melee"
export const CATEGORY_PISTOL        = "pistol"
export const CATEGORY_SHOTGUN       = "shotgun"
export const CATEGORY_SUB_MACHINE   = "submachine_gun"
export const CATEGORY_RIFLE         = "rifle"
export const CATEGORY_SNIPER_RIFLE  = "sniper_rifle"
export const CATEGORY_MACHINE_GUN   = "machine_gun"
export const CATEGORY_STICKER       = "sticker"
export const CATEGORY_CASE          = "case"
export const CATEGORY_OTHER         = "other"

// Bot Item State

export const BOT_ITEM_STATE_AVAILABLE   = 'AVAILABLE'
export const BOT_ITEM_STATE_IN_USE      = 'IN_USE'
export const BOT_ITEM_STATE_DISABLED    = 'DISABLED'

export const BATTLE_SCARRED = 0
export const WELL_WORN      = 1
export const FIELD_TESTED   = 2
export const MINIMAL_WEAR   = 3
export const FACTORY_NEW    = 4
export const VANILLA        = 5

export const WEAR = {
  'Factory New': FACTORY_NEW,
  'Minimal Wear': MINIMAL_WEAR,
  'Field-Tested': FIELD_TESTED,
  'Well-Worn': WELL_WORN,
  'Battle-Scarred': BATTLE_SCARRED
}

export const isStatTrak = name => name.toLowerCase().indexOf('stattrak') >= 0
export const isSouvenir = name => name.toLowerCase().indexOf('souvenir') >= 0

export const KNIVES         = "knives"
export const PISTOLS        = "pistols"
export const HEAVY          = "heavy"
export const SMGS           = "smgs"
export const RIFLES         = "rifles"
export const GLOVES         = "gloves"
export const CASES          = "cases"
export const OTHER          = "other"

export const ITEM_CATEGORIES = {
  [KNIVES]: ['bayonet', 'butterfly knife', 'falchion knife', 'flip knife', 'gut knife', 'huntsman knife', 'karambit', 'm9 bayonet', 'shadow daggers', 'bowie knife'],
  [PISTOLS]: ['cz75-auto','desert eagle','dual barettas','five-seven','glock-18','p2000','p250','r8 revolver','tec-9','usp-s'],
  [HEAVY]: ['mag-7','nova','sawed-off','xm1014','m249','negev'],
  [SMGS]: ['mac-10','mp7','mp9','pp-bizon','p90','ump-45'],
  [RIFLES]: ['ak-47','aug','awp','famas','g3sg1','galil ar','m4a1-s','m4a4','scar-20','sg 553','ssg 08'],
  [GLOVES]: ['bloudhound gloves','driver gloves','hand wraps','moto gloves','specialist gloves','sport gloves'],
  [CASES]: ['gamma case', 'gamma 2', 'weapon_case','Chroma 3 Case','Glove case','spectrum case']
}

export const getItemCategory = name => {
  name = name.toLowerCase()

  for(let k in ITEM_CATEGORIES) {
    for(let j of ITEM_CATEGORIES[k]) {
      if(name.indexOf(j) >= 0) {

        if(k === CASES && name.indexOf('key') >= 0) {
          return OTHER
        }

        return k
      }
    }
  }

  return OTHER
}

export const getWear = name => {
  let idx = -1

  for(let i = 0; i < name.length; i++) {
    if(name.charAt(i) === '(') {
      idx = i
    }
  }

  if(idx >= 0) {
    const wear = name.substring(idx + 1, name.length - 1).trim()
    if(typeof WEAR[wear] !== 'undefined') {
      return WEAR[wear]
    }
  }

  const category = getItemCategory(name)
  if(category === CATEGORY_MELEE) {
    return VANILLA
  }

  return -1
}
