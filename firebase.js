import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCs3WkdtkGCdEcJnMS116KO1hUcUqrSppM",
  authDomain: "refiq.netlify.app",
  projectId: "refiq-b8142",
  storageBucket: "refiq-b8142.firebasestorage.app",
  messagingSenderId: "62305657245",
  appId: "1:62305657245:web:d6e35a80859ee8fdd08f74",
  measurementId: "G-P34RBHW5HE"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
