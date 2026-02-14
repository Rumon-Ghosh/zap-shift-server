const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

// generate trackingId
function generateTrackingId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ZS-${date}-${random}`;
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// middleware
app.use(express.json());
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

// token verification middleware
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  // console.log("verify token", token)

  if (!token) {
    return res.status(401).send({ message: "Access token missing" });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    // console.log("Decoded token:", decodedToken);
    req.decoded_email = decodedToken?.email;
    next();
  } catch (error) {
    res.status(401).send({ message: "Invalid or expired token" });
  }
}

const uri = process.env.MONGODB_URI;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const zapShiftDB = client.db("zapShift");
    const userCollection = zapShiftDB.collection("users");
    const parcelCollection = zapShiftDB.collection("parcels");
    const invoiceCollection = zapShiftDB.collection("invoices");

    // users APIs
    app.post("/users", verifyFBToken, async (req, res) => {
      const user = req.body;
      const filter = { email: user?.email };
      const existingUser = await userCollection.findOne(filter);
      if (existingUser) {
        return res.send({ message: "User already exist" })
      }
      const newUser = {
        ...user,
        role: "user",
        createdAt: new Date(),
      }
      const result = await userCollection.insertOne(newUser);
      res.send(result)
    })

    // parcels API
    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const parcelData = {
        ...parcel,
        createdAt: new Date(),
        paymentStatus: "unpaid",
        deliveryStatus: "pending",
        trackingId: generateTrackingId(),
      };
      const result = await parcelCollection.insertOne(parcelData);
      res.send(result);
    });

    app.get("/parcels", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      if (!email) {
        return res.send([]);
      }
      const query = { senderEmail: email };
      const result = await parcelCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }
      const filter = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(filter);
      res.send(result);
    });

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }
      const filter = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(filter);
      res.send(result);
    });

    // payment related APIs
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { parcelId } = req.body;

        if (!parcelId) {
          return res.status(400).send({ message: "Parcel ID is required" });
        }

        // Fetch parcel from DB (trusted source)
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(parcelId),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const session = await stripe.checkout.sessions.create({
          customer_email: parcel.senderEmail,

          line_items: [
            {
              price_data: {
                currency: "bdt",
                unit_amount: parcel.cost * 100,
                product_data: {
                  name: parcel.parcelName,
                },
              },
              quantity: 1,
            },
          ],

          mode: "payment",

          metadata: {
            parcelId: parcel._id.toString(),
            parcelName: parcel.parcelName,
            trackingId: parcel.trackingId,
          },

          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/my-parcels`,
        });

        // MUST send url
        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe session error:", error);
        res.status(500).send({ message: "Payment session failed" });
      }
    });

    app.patch("/session-status", async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (!sessionId) {
          return res.status(400).send({ message: "Session ID is required" });
        }

        // 1️ Retrieve Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        // console.log("Retrieved session:", session);

        // 2️ Check payment status (VERY IMPORTANT)
        if (session.payment_status !== "paid") {
          return res.status(400).send({
            message: "Payment not completed",
            payment_status: session.payment_status,
          });
        }

        // 3️ Get parcelId from metadata
        const parcelId = session.metadata?.parcelId;

        if (!parcelId) {
          return res
            .status(400)
            .send({ message: "Parcel ID not found in metadata" });
        }

        // 4️ Update parcel payment status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: "paid",
              transactionId: session.payment_intent,
              paidAt: new Date(),
            },
          },
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(500)
            .send({ message: "Failed to update payment status" });
        }

        // 5 create invoice and store in DB
        const invoiceData = {
          parcelId: new ObjectId(parcelId),
          parcelName: session.metadata?.parcelName || "Unknown Parcel",
          paidBy: session.customer_email,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          paidAt: new Date(),
          trackingId: session.metadata?.trackingId || "N/A",
        };

        const invoiceExists = await invoiceCollection.findOne({
          parcelId: new ObjectId(parcelId),
        });

        if (!invoiceExists) {
          const invoiceResult = await invoiceCollection.insertOne(invoiceData);
          if (!invoiceResult.acknowledged) {
            console.error("Failed to create invoice:", invoiceData);
            return res.status(500).send({ message: "Failed to create invoice" });
          }
        }

        // 6 Respond success
        res.send({
          message: "Payment verified and parcel updated",
          session,
        });
      } catch (error) {
        console.error("Session verification error:", error);
        res.status(500).send({ message: "Payment verification failed" });
      }
    });

    // invoice API
    app.get("/invoices", verifyFBToken, async (req, res) => {
      const email = req.decoded_email;
      if (!email) {
        return res.send([]);
      }
      const query = { paidBy: email };
      const result = await invoiceCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap Shift Server is running!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
