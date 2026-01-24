// Convert studs to pixels (1 pixel = 0.5 mm)

// Existing unit conversion factor
const STUD_TO_PX = 2; // (1 pixel = 0.5 mm implies 1 stud = 2px)

// Update relevant code with new scaling logic
const toPx = (v: Vec2) => {
    return { x: v.x * STUD_TO_PX, y: v.y * STUD_TO_PX };
}

// Assuming this pattern repeats and refactors in related files.