import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

let scene, camera, renderer;
let controller1, controller2;
let cubes = [];
let grabbedCube = null;
let pendingCube = null;
let buttonMesh;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const CubeSize = 0.1;

// Variables for left controller color cycling.
const availableColors = [0xff0000, 0x00ff00, 0x0000ff]; // red, green, blue
let pendingColorIndex = 0;
let pendingColor = availableColors[pendingColorIndex];
let leftJoystickXPrev = 0;

// Globals for the connection feature:
const selectedCubes = [];         // Array to store cubes that have been “selected”
const connections = [];           // Array of connection objects: { cubeA, cubeB, line }

init();
animate();

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);

    camera = new THREE.PerspectiveCamera(70, window.innerWidth/window.innerHeight, 0.1, 100);
    camera.position.set(0, 1.6, 0);

    const light = new THREE.HemisphereLight(0xffffff, 0x444444);
    scene.add(light);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);
    document.body.appendChild(VRButton.createButton(renderer));

    // Floor
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(4, 4),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
    );
    floor.rotation.x = -Math.PI/2;
    scene.add(floor);

    // Simple button to click (for other interactions)
    buttonMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.1, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x0077ff })
    );
    buttonMesh.position.set(0, 1.5, -1);
    scene.add(buttonMesh);

    // LEFT CONTROLLER (for cube creation and connection selection)
    controller1 = renderer.xr.getController(0);
    controller1.addEventListener('selectstart', onSelectStartLeft);
    controller1.addEventListener('selectend', onSelectEndLeft);
    // Use left squeeze to "select" (mark) a cube for connection
    controller1.addEventListener('squeezestart', onSqueezeStartLeft);
    scene.add(controller1);

    // RIGHT CONTROLLER (for grabbing cubes)
    controller2 = renderer.xr.getController(1);
    controller2.addEventListener('selectstart', onSelectStartRight);
    controller2.addEventListener('selectend', onSelectEndRight);
    scene.add(controller2);

    // Add a simple ray pointer to the right controller
    const pointerGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0,0,0),
        new THREE.Vector3(0,0,-1)
    ]);
    const pointerMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    const pointerLine = new THREE.Line(pointerGeometry, pointerMaterial);
    pointerLine.scale.z = 10;
    controller2.add(pointerLine);

    // Add controller models.
    const factory = new XRControllerModelFactory();
    const grip1 = renderer.xr.getControllerGrip(0);
    grip1.add(factory.createControllerModel(grip1));
    scene.add(grip1);

    const grip2 = renderer.xr.getControllerGrip(1);
    grip2.add(factory.createControllerModel(grip2));
    scene.add(grip2);

    window.addEventListener('resize', onWindowResize);
}

/////////////////////////
// LEFT CONTROLLER: Cube creation.
function onSelectStartLeft(event) {
    const controller = event.target;
    const geometry = new THREE.BoxGeometry(CubeSize, CubeSize, CubeSize);
    const material = new THREE.MeshStandardMaterial({ color: pendingColor });
    pendingCube = new THREE.Mesh(geometry, material);
    controller.add(pendingCube);
    pendingCube.position.set(0,0,-0.5);
}

function onSelectEndLeft(event) {
    const controller = event.target;
    if (pendingCube) {
        controller.remove(pendingCube);
        pendingCube.position.setFromMatrixPosition(pendingCube.matrixWorld);
        scene.add(pendingCube);
        cubes.push(pendingCube);
        pendingCube = null;
    }
}

/////////////////////////
// LEFT CONTROLLER: Squeeze event for connection selection.
function onSqueezeStartLeft(event) {
    // We assume that a cube is grabbed by the right controller (grabbedCube)
    if (grabbedCube) {
        // If there are already two cubes selected, prevent selecting another
        if (selectedCubes.length >= 2) {
            console.log("You need to select another pair of cubes.");
            return;
        }

        // Add the grabbed cube to the selected cubes array if not already present
        if (selectedCubes.indexOf(grabbedCube) === -1) {
            selectedCubes.push(grabbedCube);
            console.log('Cube added to selection:', grabbedCube);
        }

        // If exactly two cubes are now selected, create a connection
        if (selectedCubes.length === 2) {
            createConnectionBetween(selectedCubes[0], selectedCubes[1]);
            // Reset the selectedCubes array so the user must select a new pair
            selectedCubes.length = 0;
        }
    }
}

function createConnectionBetween(cubeA, cubeB) {
    const pos1 = new THREE.Vector3();
    const pos2 = new THREE.Vector3();
    cubeA.getWorldPosition(pos1);
    cubeB.getWorldPosition(pos2);
    const geometry = new THREE.BufferGeometry().setFromPoints([pos1, pos2]);
    const material = new THREE.LineBasicMaterial({ color: 0xffffff });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    connections.push({ cubeA, cubeB, line });
    console.log('Connection created between cubes:', cubeA, cubeB);
}


/////////////////////////
// Helper: Check if a connection exists between two cubes.
function connectionExists(cubeA, cubeB) {
    return connections.some(conn =>
        (conn.cubeA === cubeA && conn.cubeB === cubeB) ||
        (conn.cubeA === cubeB && conn.cubeB === cubeA)
    );
}



/////////////////////////
// RIGHT CONTROLLER: Grabbing cubes.
function onSelectStartRight(event) {
    const controller = event.target;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0,0,-1).applyMatrix4(tempMatrix);

    // Check for a button click.
    const buttonHit = raycaster.intersectObject(buttonMesh);
    if (buttonHit.length > 0) {
        buttonMesh.material.color.setHex(Math.random()*0xffffff);
        console.log('Button clicked!');
        return;
    }
    // Check for cube grabbing.
    const intersects = raycaster.intersectObjects(cubes);
    if (intersects.length > 0) {
        grabbedCube = intersects[0].object;
        controller.attach(grabbedCube);
        // Set emissive for visual feedback.
        if (grabbedCube.material && grabbedCube.material.emissive !== undefined) {
            grabbedCube.material.emissive = new THREE.Color(0xffff00);
        }
    }
}

function onSelectEndRight(event) {
    if (grabbedCube) {
        if (grabbedCube.material && grabbedCube.material.emissive !== undefined) {
            grabbedCube.material.emissive.setHex(0x000000);
        }
        scene.attach(grabbedCube);
        grabbedCube = null;
    }
}

/////////////////////////
// Window resize
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

/////////////////////////
// ANIMATE: Update cube movement and update connection lines.
function animate() {
    renderer.setAnimationLoop(() => {
        const session = renderer.xr.getSession();

        // Update pending cube color using left controller's joystick (color cycling)
        if (session && pendingCube) {
            for (let inputSource of session.inputSources) {
                if (inputSource.handedness === 'left' && inputSource.gamepad) {
                    const axes = inputSource.gamepad.axes;
                    const axisX = axes[2];
                    if (axisX > 0.8 && leftJoystickXPrev <= 0.8) {
                        pendingColorIndex = (pendingColorIndex + 1) % availableColors.length;
                        pendingColor = availableColors[pendingColorIndex];
                        pendingCube.material.color.setHex(pendingColor);
                    } else if (axisX < -0.8 && leftJoystickXPrev >= -0.8) {
                        pendingColorIndex = (pendingColorIndex - 1 + availableColors.length) % availableColors.length;
                        pendingColor = availableColors[pendingColorIndex];
                        pendingCube.material.color.setHex(pendingColor);
                    }
                    leftJoystickXPrev = axisX;
                }
            }
        }

        // RIGHT CONTROLLER: Handle movement and deletion if a cube is grabbed.
        if (session && grabbedCube) {
            for (let inputSource of session.inputSources) {
                if (inputSource.handedness === 'right' && inputSource.gamepad) {
                    const axes = inputSource.gamepad.axes;
                    const buttons = inputSource.gamepad.buttons;
                    const dy = axes[3];
                    const deadzone = 0.05;
                    const moveSpeed = 0.05;
                    if (Math.abs(dy) > deadzone) {
                        const direction = new THREE.Vector3(0,0,-1);
                        const worldMatrix = new THREE.Matrix4().copy(controller2.matrixWorld);
                        direction.applyMatrix4(worldMatrix).sub(controller2.position).normalize();
                        direction.multiplyScalar(dy * moveSpeed);
                        grabbedCube.position.add(direction);
                    }
                    // Delete cube if right grip (buttons[1]) is pressed.
                    if (buttons[1] && buttons[1].pressed) {
                        console.log('Deleting grabbed cube.');
                        if (grabbedCube.parent !== scene) {
                            scene.attach(grabbedCube);
                        }
                        scene.remove(grabbedCube);
                        // Remove it from cubes array.
                        const cubeIndex = cubes.indexOf(grabbedCube);
                        if (cubeIndex !== -1) cubes.splice(cubeIndex, 1);
                        // Also remove from selectedCubes and any connections.
                        removeConnectionsForCube(grabbedCube);
                        const selIndex = selectedCubes.indexOf(grabbedCube);
                        if (selIndex !== -1) selectedCubes.splice(selIndex, 1);
                        grabbedCube = null;
                    }
                }
            }
        }

        // Update all connection lines to match the cubes’ current world positions.
        connections.forEach(conn => {
            const pos1 = new THREE.Vector3();
            const pos2 = new THREE.Vector3();
            conn.cubeA.getWorldPosition(pos1);
            conn.cubeB.getWorldPosition(pos2);
            const positions = conn.line.geometry.attributes.position.array;
            positions[0] = pos1.x; positions[1] = pos1.y; positions[2] = pos1.z;
            positions[3] = pos2.x; positions[4] = pos2.y; positions[5] = pos2.z;
            conn.line.geometry.attributes.position.needsUpdate = true;
        });

        renderer.render(scene, camera);
    });
}

// Helper: Remove any connections involving a given cube.
function removeConnectionsForCube(cube) {
    for (let i = connections.length - 1; i >= 0; i--) {
        const conn = connections[i];
        if (conn.cubeA === cube || conn.cubeB === cube) {
            scene.remove(conn.line);
            connections.splice(i, 1);
        }
    }
}
